import { check, foreignKey, index, jsonb, pgTable, primaryKey, smallint, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Physical PostgreSQL schema (DATA-W3, ADR-DATA-001/ARCH-015).
 *
 * Key strategy (amendment 8): composite primary keys (organization_id, entity_id)
 * on every tenant-owned table, chosen over a globally-unique surrogate ID after
 * comparing both — see docs/data/DATA_PERSISTENCE_REQUIREMENTS.md and the
 * DATA-W3 session report for the full reasoning. In short: (1) DATA-W1's own
 * in-memory repositories already test that the SAME entity id string may
 * validly exist under two different organizations (test H) — a globally
 * unique ID would silently change that tested behavior; (2) a composite PK
 * makes every foreign key to it automatically organization-scoped, so there
 * is no "wrong, simpler" FK a future migration could accidentally write; a
 * global-ID design has exactly that trap (FK to the bare global PK instead
 * of the composite unique constraint); (3) it needs one index per table
 * instead of two (PK + separate tenant-uniqueness index).
 *
 * RLS, triggers, roles, and grants are NOT expressible in Drizzle's schema
 * DSL and are not generated from this file — see drizzle/0001_rls_and_roles.sql.
 */

export const organizations = pgTable(
  'organizations',
  {
    organizationId: text('organization_id').primaryKey(),
    organizationType: text('organization_type').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('organizations_status_check', sql`${table.status} IN ('active','inactive')`)],
);

export const goals = pgTable(
  'goals',
  {
    organizationId: text('organization_id').notNull(),
    goalId: text('goal_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: text('status').notNull(),
    ownerExecutive: text('owner_executive'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.goalId] }),
    foreignKey({
      name: 'goals_organization_id_fkey',
      columns: [table.organizationId],
      foreignColumns: [organizations.organizationId],
    }),
    check('goals_status_check', sql`${table.status} IN ('active','completed','archived')`),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    organizationId: text('organization_id').notNull(),
    recommendationId: text('recommendation_id').notNull(),
    goalId: text('goal_id').notNull(),
    owningExecutive: text('owning_executive').notNull(),
    originatingSkill: text('originating_skill').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    approvalRequirement: smallint('approval_requirement').notNull(),
    risk: text('risk').notNull(),
    evidenceReferences: jsonb('evidence_references').notNull().default([]),
    confidence: smallint('confidence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.recommendationId] }),
    foreignKey({
      name: 'recommendations_goal_fkey',
      columns: [table.organizationId, table.goalId],
      foreignColumns: [goals.organizationId, goals.goalId],
    }),
    check('recommendations_status_check', sql`${table.status} IN ('Draft','Ready for Approval','Awaiting Clarification','Rejected')`),
    check('recommendations_approval_requirement_check', sql`${table.approvalRequirement} BETWEEN 1 AND 5`),
    check('recommendations_risk_check', sql`${table.risk} IN ('low','moderate','high','critical')`),
    check('recommendations_confidence_check', sql`${table.confidence} BETWEEN 0 AND 100`),
    index('recommendations_org_goal_idx').on(table.organizationId, table.goalId),
  ],
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    organizationId: text('organization_id').notNull(),
    approvalRequestId: text('approval_request_id').notNull(),
    goalId: text('goal_id').notNull(),
    recommendationId: text('recommendation_id').notNull(),
    requestedBy: text('requested_by').notNull(),
    requiredApprovalLevel: smallint('required_approval_level').notNull(),
    risk: text('risk').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.approvalRequestId] }),
    foreignKey({
      name: 'approval_requests_recommendation_fkey',
      columns: [table.organizationId, table.recommendationId],
      foreignColumns: [recommendations.organizationId, recommendations.recommendationId],
    }),
    check('approval_requests_status_check', sql`${table.status} IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')`),
    check('approval_requests_level_check', sql`${table.requiredApprovalLevel} BETWEEN 1 AND 5`),
    check('approval_requests_risk_check', sql`${table.risk} IN ('low','moderate','high','critical')`),
    index('approval_requests_org_rec_idx').on(table.organizationId, table.recommendationId),
    index('approval_requests_org_status_idx').on(table.organizationId, table.status),
  ],
);

export const approvalRecords = pgTable(
  'approval_records',
  {
    organizationId: text('organization_id').notNull(),
    approvalRecordId: text('approval_record_id').notNull(),
    approvalRequestId: text('approval_request_id').notNull(),
    goalId: text('goal_id').notNull(),
    recommendationId: text('recommendation_id').notNull(),
    requiredApprovalLevel: smallint('required_approval_level').notNull(),
    decision: text('decision').notNull(),
    approverId: text('approver_id').notNull(),
    approverRole: text('approver_role').notNull(),
    rationale: text('rationale'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    previousState: text('previous_state').notNull(),
    resultingState: text('resulting_state').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.approvalRecordId] }),
    foreignKey({
      name: 'approval_records_request_fkey',
      columns: [table.organizationId, table.approvalRequestId],
      foreignColumns: [approvalRequests.organizationId, approvalRequests.approvalRequestId],
    }),
    // At most one terminal record per request — DB-enforced, not just governance-enforced.
    unique('approval_records_one_per_request').on(table.organizationId, table.approvalRequestId),
    check('approval_records_decision_check', sql`${table.decision} IN ('APPROVED','REJECTED','EXPIRED','CANCELLED')`),
    check('approval_records_level_check', sql`${table.requiredApprovalLevel} BETWEEN 1 AND 5`),
  ],
);
