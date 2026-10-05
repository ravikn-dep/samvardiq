import { sql } from 'drizzle-orm';
import { check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * PLATFORM-CREDENTIALS-W1 (ARCH-020). Three organization-scoped tables, same
 * `(organization_id, entity_id)` composite-key discipline as every other
 * package:
 *
 * - `external_provider_connections` — non-secret connection metadata.
 * - `external_provider_credentials` — the secret envelope only. Its
 *   `(organization_id, connection_id, provider)` foreign key makes a
 *   credential's provider (which is bound into the AAD) always equal its
 *   connection's provider.
 * - `external_provider_credential_events` — append-only lifecycle audit,
 *   identifiers only (same pattern as `identity_audit_events` /
 *   `conversation_handoffs`).
 *
 * Grants, RLS + FORCE RLS and the immutability trigger are hand-written in
 * drizzle/0000_*.sql below the generated DDL.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const IDENTIFIER = `'^[a-z][a-z0-9_]{1,62}$'`;

export const externalProviderConnections = pgTable(
  'external_provider_connections',
  {
    organizationId: text('organization_id').notNull(),
    connectionId: text('connection_id').notNull(),
    provider: text('provider').notNull(),
    // Nullable: not every provider exposes an account identifier.
    externalAccountId: text('external_account_id'),
    status: text('status').notNull(),
    grantedScopes: jsonb('granted_scopes').$type<string[]>().notNull(),
    connectedByIdentityId: text('connected_by_identity_id').notNull(),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.connectionId] }),
    unique('external_provider_connections_provider_key').on(table.organizationId, table.connectionId, table.provider),
    check('external_provider_connections_status_check', sql`${table.status} IN ('ACTIVE','NEEDS_REAUTH','DISCONNECTED')`),
    check('external_provider_connections_disconnected_check', sql`(${table.status} = 'DISCONNECTED') = (${table.disconnectedAt} IS NOT NULL)`),
    check('external_provider_connections_provider_check', sql`${table.provider} ~ ${sql.raw(IDENTIFIER)}`),
    check('external_provider_connections_scopes_check', sql`jsonb_typeof(${table.grantedScopes}) = 'array'`),
  ],
);

export const externalProviderCredentials = pgTable(
  'external_provider_credentials',
  {
    organizationId: text('organization_id').notNull(),
    credentialId: text('credential_id').notNull(),
    connectionId: text('connection_id').notNull(),
    provider: text('provider').notNull(),
    credentialType: text('credential_type').notNull(),
    algorithm: text('algorithm').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    payloadNonce: bytea('payload_nonce').notNull(),
    payloadTag: bytea('payload_tag').notNull(),
    wrappedKey: bytea('wrapped_key').notNull(),
    wrapNonce: bytea('wrap_nonce').notNull(),
    wrapTag: bytea('wrap_tag').notNull(),
    keyVersion: integer('key_version').notNull(),
    keyCheck: bytea('key_check').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.credentialId] }),
    unique('external_provider_credentials_connection_type_key').on(table.organizationId, table.connectionId, table.credentialType),
    foreignKey({
      name: 'external_provider_credentials_connection_fkey',
      columns: [table.organizationId, table.connectionId, table.provider],
      foreignColumns: [externalProviderConnections.organizationId, externalProviderConnections.connectionId, externalProviderConnections.provider],
    }),
    check('external_provider_credentials_type_check', sql`${table.credentialType} ~ ${sql.raw(IDENTIFIER)}`),
    check('external_provider_credentials_algorithm_check', sql`${table.algorithm} = 'AES-256-GCM'`),
    check(
      'external_provider_credentials_envelope_check',
      sql`octet_length(${table.ciphertext}) BETWEEN 1 AND 16384
          AND octet_length(${table.payloadNonce}) = 12 AND octet_length(${table.payloadTag}) = 16
          AND octet_length(${table.wrappedKey}) = 32 AND octet_length(${table.wrapNonce}) = 12 AND octet_length(${table.wrapTag}) = 16
          AND octet_length(${table.keyCheck}) = 16 AND ${table.keyVersion} > 0`,
    ),
    index('external_provider_credentials_key_version_idx').on(table.keyVersion),
  ],
);

export const externalProviderCredentialEvents = pgTable(
  'external_provider_credential_events',
  {
    organizationId: text('organization_id').notNull(),
    eventId: text('event_id').notNull(),
    connectionId: text('connection_id').notNull(),
    credentialId: text('credential_id'),
    eventType: text('event_type').notNull(),
    actorPrincipalType: text('actor_principal_type').notNull(),
    actorIdentityId: text('actor_identity_id'),
    keyVersion: integer('key_version'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.eventId] }),
    foreignKey({
      name: 'external_provider_credential_events_connection_fkey',
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [externalProviderConnections.organizationId, externalProviderConnections.connectionId],
    }),
    check(
      'external_provider_credential_events_type_check',
      sql`${table.eventType} IN ('CONNECTION_CREATED','CREDENTIAL_STORED','CREDENTIAL_REPLACED','CREDENTIAL_REWRAPPED','CONNECTION_NEEDS_REAUTH','CONNECTION_DISCONNECTED','CREDENTIAL_DELETED')`,
    ),
    check(
      'external_provider_credential_events_actor_check',
      sql`(${table.actorPrincipalType} IN ('human','service') AND ${table.actorIdentityId} IS NOT NULL)
          OR (${table.actorPrincipalType} = 'system' AND ${table.actorIdentityId} IS NULL)`,
    ),
    index('external_provider_credential_events_connection_idx').on(table.organizationId, table.connectionId, table.occurredAt),
  ],
);
