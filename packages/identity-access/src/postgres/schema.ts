import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Physical PostgreSQL schema (IDENTITY-W2, ARCH-016).
 *
 * `identities` and `identity_provider_links` are platform-global — NOT
 * organization-scoped, per ADR-IDENTITY-001's explicit reasoning (an
 * identity can belong to many organizations, so it cannot itself be
 * organization-scoped) and per this session's own instruction: "Do not
 * blindly force composite keys onto platform-global identity if that
 * creates incorrect semantics." Neither table gets RLS.
 *
 * `organization_memberships` is the one organization-scoped table here,
 * using the same `(organization_id, entity_id)` composite-PK discipline
 * DATA-W3 already established and tested — reused, not reinvented.
 *
 * Deliberately NO foreign key from `organization_memberships.organization_id`
 * to any `organizations` table — this package owns no such table (see
 * src/types.ts's package-boundary note). `identity_id` DOES get a real
 * FK to `identities`, since that table lives in this same package.
 */

export const identities = pgTable(
  'identities',
  {
    identityId: text('identity_id').primaryKey(),
    principalType: text('principal_type').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('identities_principal_type_check', sql`${table.principalType} IN ('human','service')`),
    check('identities_status_check', sql`${table.status} IN ('active','suspended','revoked')`),
  ],
);

export const identityProviderLinks = pgTable(
  'identity_provider_links',
  {
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject').notNull(),
    identityId: text('identity_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerSubject] }),
    foreignKey({
      name: 'identity_provider_links_identity_fkey',
      columns: [table.identityId],
      foreignColumns: [identities.identityId],
    }),
  ],
);

/**
 * IDENTITY-W6, ADR-IDENTITY-001 "Audit Requirements": append-only identity
 * security audit trail. Same immutability philosophy already proven for
 * `approval_records` in data-foundation (INSERT/SELECT-only GRANT, plus a
 * role-independent BEFORE UPDATE/DELETE trigger — see
 * drizzle/0002_identity_audit_events_immutability.sql).
 *
 * `organizationId` is nullable BY DESIGN, not sloppiness: `IDENTITY_*` and
 * `PROVIDER_LINK_*` events are platform-global (an identity is not owned by
 * one organization), while `MEMBERSHIP_*` events are always organization-
 * scoped. The check constraint below enforces exactly this split at the
 * database layer, not merely by application convention — see RLS policy in
 * the same migration for how NULL-scoped rows are kept invisible to any
 * tenant context (never "visible to everyone").
 *
 * No FK to data-foundation's `organizations` table, for the same
 * package-boundary reason `organization_memberships` has none (see this
 * file's own top-of-file note and src/types.ts).
 */
export const identityAuditEvents = pgTable(
  'identity_audit_events',
  {
    eventId: text('event_id').primaryKey(),
    organizationId: text('organization_id'),
    actorIdentityId: text('actor_identity_id'),
    actorPrincipalType: text('actor_principal_type').notNull(),
    eventType: text('event_type').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').notNull().default({}),
    // Database-generated occurrence time (section 17) — never accepted as a
    // caller-supplied value; see the audit repository, which has no field
    // for it in its append() input.
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'identity_audit_events_actor_identity_fkey',
      columns: [table.actorIdentityId],
      foreignColumns: [identities.identityId],
    }),
    check(
      'identity_audit_events_actor_principal_type_check',
      sql`${table.actorPrincipalType} IN ('human','service','system')`,
    ),
    check(
      'identity_audit_events_actor_consistency_check',
      sql`(${table.actorPrincipalType} = 'system' AND ${table.actorIdentityId} IS NULL) OR (${table.actorPrincipalType} IN ('human','service') AND ${table.actorIdentityId} IS NOT NULL)`,
    ),
    check(
      'identity_audit_events_event_type_check',
      sql`${table.eventType} IN ('IDENTITY_CREATED','IDENTITY_STATUS_CHANGED','PROVIDER_LINK_CREATED','PROVIDER_LINK_REMOVED','MEMBERSHIP_CREATED','MEMBERSHIP_STATUS_CHANGED','MEMBERSHIP_ROLE_CHANGED','AUTHENTICATION_FAILED','AUTHORIZATION_FAILED')`,
    ),
    check(
      'identity_audit_events_organization_scope_check',
      sql`(${table.eventType} IN ('MEMBERSHIP_CREATED','MEMBERSHIP_STATUS_CHANGED','MEMBERSHIP_ROLE_CHANGED') AND ${table.organizationId} IS NOT NULL) OR (${table.eventType} IN ('IDENTITY_CREATED','IDENTITY_STATUS_CHANGED','PROVIDER_LINK_CREATED','PROVIDER_LINK_REMOVED') AND ${table.organizationId} IS NULL) OR ${table.eventType} IN ('AUTHENTICATION_FAILED','AUTHORIZATION_FAILED')`,
    ),
    check('identity_audit_events_target_type_check', sql`${table.targetType} IN ('IDENTITY','MEMBERSHIP','PROVIDER_LINK')`),
    check('identity_audit_events_outcome_check', sql`${table.outcome} IN ('SUCCESS','DENIED','FAILED')`),
    check('identity_audit_events_reason_length_check', sql`${table.reason} IS NULL OR char_length(${table.reason}) <= 500`),
  ],
);

export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    organizationId: text('organization_id').notNull(),
    identityId: text('identity_id').notNull(),
    role: text('role').notNull(),
    approverRole: text('approver_role'),
    status: text('status').notNull(),
    invitedBy: text('invited_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.identityId] }),
    foreignKey({
      name: 'organization_memberships_identity_fkey',
      columns: [table.identityId],
      foreignColumns: [identities.identityId],
    }),
    check('organization_memberships_role_check', sql`${table.role} IN ('OWNER','MEMBER','VIEWER')`),
    check(
      'organization_memberships_approver_role_check',
      sql`${table.approverRole} IS NULL OR ${table.approverRole} IN ('hr_manager','marketing_manager','operations_manager','finance_manager','clinic_director','founder')`,
    ),
    check('organization_memberships_status_check', sql`${table.status} IN ('INVITED','ACTIVE','SUSPENDED','REVOKED')`),
  ],
);
