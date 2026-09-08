import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

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
