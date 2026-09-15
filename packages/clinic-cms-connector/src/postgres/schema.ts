import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Physical PostgreSQL schema (CLINIC-W1B-2). Both tables are
 * organization-scoped, using the same `(organization_id, entity_id)`
 * composite-PK discipline ADR-DATA-001/DATA-W3 established and
 * identity-access's `organization_memberships` already reuses — not
 * reinvented here.
 *
 * `secretReference` is an opaque pointer (e.g. `env:CLINIC_CMS_ACME_SECRET`)
 * resolved by a `ConnectorSecretProvider` at the point of use — the raw
 * HMAC secret is never a column in this table, so a `SELECT *` here (an
 * admin tool, a backup, a future reporting query) can never disclose it.
 *
 * RLS, the runtime role, and grants are NOT expressible in Drizzle's schema
 * DSL and are not generated from this file — see drizzle/0000_*.sql.
 */

export const clinicCmsConnections = pgTable(
  'clinic_cms_connections',
  {
    organizationId: text('organization_id').notNull(),
    connectionId: text('connection_id').notNull(),
    baseUrl: text('base_url').notNull(),
    keyId: text('key_id').notNull(),
    secretReference: text('secret_reference').notNull(),
    approvedScopes: jsonb('approved_scopes').notNull(),
    timezone: text('timezone').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.connectionId] })],
);

/**
 * Connector execution evidence (section 22) — append-only by grant (see
 * migration). No column exists for a secret, signature, raw request, or
 * raw response, matching this package's `ConnectorExecutionEvidence`
 * TypeScript type exactly (see connectorAuditRepository.ts) — the schema
 * and the type are kept in lockstep deliberately, so a future column
 * addition here forces a conscious type change too.
 */
export const clinicCmsConnectorEvidence = pgTable(
  'clinic_cms_connector_evidence',
  {
    organizationId: text('organization_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    connectionId: text('connection_id').notNull(),
    connectorType: text('connector_type').notNull(),
    operation: text('operation').notNull(),
    correlationId: text('correlation_id').notNull(),
    externalResourceType: text('external_resource_type'),
    externalResourceId: text('external_resource_id'),
    outcome: text('outcome').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    safeErrorCategory: text('safe_error_category'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.evidenceId] }),
    check('clinic_cms_connector_evidence_outcome_check', sql`${table.outcome} IN ('SUCCESS','DENIED','ERROR')`),
  ],
);
