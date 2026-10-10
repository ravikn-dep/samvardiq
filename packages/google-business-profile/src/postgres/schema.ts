import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * GBP-W1 (Founder decisions G2/G3, 2026-10-10). Three organization-scoped
 * tables, RLS + FORCE RLS. Each references the ARCH-020 connection by
 * `(organization_id, connection_id, provider)` — that foreign key, the
 * cross-package one-open-connection index, the immutability trigger and the
 * grants are hand-written in drizzle/0000_*.sql below the generated DDL.
 *
 * - `gbp_location_candidates`: the non-secret account/location references
 *   Google returned for a connection at its last discovery. Replaced wholesale
 *   on each discovery. Stable provider resource names are the identity;
 *   titles/addresses are display metadata only and never authority.
 * - `gbp_location_bindings`: one row per binding episode, never deleted —
 *   the binding history. `unbound_at IS NULL` = an active binding. An
 *   organization may hold several (G3); a location is actively bound to at
 *   most ONE organization globally (partial unique index). `access_lost_at`
 *   is set while Google no longer returns the location to the connection (or
 *   while a re-authorization awaits revalidation): such a binding must not be
 *   used until discovery returns it again or the OWNER unbinds it.
 * - `gbp_operation_events`: append-only audit of OWNER-requested,
 *   service-principal-executed provider operations (G1): the human request
 *   and the service outcome, correlated by `request_id`. Identifiers and a
 *   fixed failure class only — never a token, code, state or provider body.
 */
const PROVIDER = `'google_business_profile'`;
const LOCATION = `'^locations/[A-Za-z0-9_-]{1,64}$'`;
const ACCOUNT = `'^accounts/[A-Za-z0-9_-]{1,64}$'`;

export const gbpLocationCandidates = pgTable(
  'gbp_location_candidates',
  {
    organizationId: text('organization_id').notNull(),
    connectionId: text('connection_id').notNull(),
    provider: text('provider').notNull(),
    locationName: text('location_name').notNull(),
    accountName: text('account_name').notNull(),
    accountDisplayName: text('account_display_name').notNull(),
    title: text('title').notNull(),
    addressSummary: text('address_summary'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.connectionId, table.locationName] }),
    check('gbp_location_candidates_provider_check', sql`${table.provider} = ${sql.raw(PROVIDER)}`),
    check('gbp_location_candidates_location_check', sql`${table.locationName} ~ ${sql.raw(LOCATION)}`),
    check('gbp_location_candidates_account_check', sql`${table.accountName} ~ ${sql.raw(ACCOUNT)}`),
    check(
      'gbp_location_candidates_metadata_check',
      sql`char_length(${table.title}) <= 200 AND char_length(${table.accountDisplayName}) <= 200 AND coalesce(char_length(${table.addressSummary}), 0) <= 300`,
    ),
  ],
);

export const gbpLocationBindings = pgTable(
  'gbp_location_bindings',
  {
    organizationId: text('organization_id').notNull(),
    bindingId: text('binding_id').notNull(),
    connectionId: text('connection_id').notNull(),
    provider: text('provider').notNull(),
    locationName: text('location_name').notNull(),
    accountName: text('account_name').notNull(),
    title: text('title').notNull(),
    boundByIdentityId: text('bound_by_identity_id').notNull(),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
    unboundAt: timestamp('unbound_at', { withTimezone: true }),
    unboundByIdentityId: text('unbound_by_identity_id'),
    unbindReason: text('unbind_reason'),
    accessLostAt: timestamp('access_lost_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.bindingId] }),
    check('gbp_location_bindings_provider_check', sql`${table.provider} = ${sql.raw(PROVIDER)}`),
    check('gbp_location_bindings_location_check', sql`${table.locationName} ~ ${sql.raw(LOCATION)}`),
    check('gbp_location_bindings_account_check', sql`${table.accountName} ~ ${sql.raw(ACCOUNT)}`),
    check('gbp_location_bindings_title_check', sql`char_length(${table.title}) <= 200`),
    check('gbp_location_bindings_reason_check', sql`${table.unbindReason} IN ('OWNER_UNBOUND','CONNECTION_DISCONNECTED')`),
    check('gbp_location_bindings_unbound_check', sql`(${table.unboundAt} IS NULL) = (${table.unbindReason} IS NULL) AND (${table.unboundAt} IS NOT NULL OR ${table.unboundByIdentityId} IS NULL)`),
    uniqueIndex('gbp_location_bindings_active_location_key').on(table.locationName).where(sql`${table.unboundAt} IS NULL`),
    index('gbp_location_bindings_connection_idx').on(table.organizationId, table.connectionId),
  ],
);

export const gbpOperationEvents = pgTable(
  'gbp_operation_events',
  {
    organizationId: text('organization_id').notNull(),
    eventId: text('event_id').notNull(),
    requestId: text('request_id').notNull(),
    connectionId: text('connection_id').notNull(),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    phase: text('phase').notNull(),
    actorPrincipalType: text('actor_principal_type').notNull(),
    actorIdentityId: text('actor_identity_id').notNull(),
    failureClass: text('failure_class'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.eventId] }),
    check('gbp_operation_events_provider_check', sql`${table.provider} = ${sql.raw(PROVIDER)}`),
    check('gbp_operation_events_operation_check', sql`${table.operation} IN ('GBP_DISCOVER_LOCATIONS','GBP_VERIFY_CONNECTION','GBP_REVOKE_CONNECTION')`),
    check('gbp_operation_events_phase_check', sql`${table.phase} IN ('REQUESTED','SUCCEEDED','FAILED')`),
    check('gbp_operation_events_actor_check', sql`(${table.phase} = 'REQUESTED') = (${table.actorPrincipalType} = 'human') AND ${table.actorPrincipalType} IN ('human','service')`),
    check('gbp_operation_events_failure_check', sql`(${table.phase} = 'FAILED') = (${table.failureClass} IS NOT NULL) AND coalesce(${table.failureClass} ~ '^[a-z][a-z0-9_]{1,63}$', true)`),
    index('gbp_operation_events_request_idx').on(table.organizationId, table.requestId),
  ],
);
