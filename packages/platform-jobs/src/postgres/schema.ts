import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * PLATFORM-JOBS-W1 (ARCH-021). One PLATFORM-GLOBAL table of durable job
 * instructions — identifiers only, no tenant data — in the same category as
 * `webhook_event_dedup` / `communication_channels`: no tenant RLS in the
 * package migration; on Supabase the hardening step enables RLS with the
 * samvardiq_app-scoped policy. A job is an instruction, never authority:
 * consumers re-resolve their own organization/service authority before work.
 *
 * Every column has a consumer:
 * - `idempotency_key` + UNIQUE(job_type, idempotency_key): duplicate enqueue / concurrent ticks collapse to one job.
 * - `lease_id`: a fresh UUID per claim — the fencing token every completion, failure and renewal must present.
 * - `lease_owner`: which worker holds it (diagnosis of stale leases only; never authority).
 * - `attempts`/`max_attempts`: bounded retry; `run_after`: scheduling, backoff and "not before".
 * - `last_failure_class`: sanitized code only — never an exception message.
 * Grants and the CHECKs that keep the state machine coherent are in drizzle/0000_*.sql.
 */
export const platformJobs = pgTable(
  'platform_jobs',
  {
    jobId: uuid('job_id').primaryKey(),
    jobType: text('job_type').notNull(),
    // NULL only for explicitly platform-global maintenance jobs (ARCH-021).
    organizationId: text('organization_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').$type<Record<string, string | number | boolean>>().notNull(),
    status: text('status').notNull(),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    leaseId: uuid('lease_id'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastFailureClass: text('last_failure_class'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('platform_jobs_idempotency_key').on(table.jobType, table.idempotencyKey),
    check('platform_jobs_status_check', sql`${table.status} IN ('PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','DEAD')`),
    check('platform_jobs_type_check', sql`${table.jobType} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$' AND char_length(${table.jobType}) <= 64`),
    check('platform_jobs_key_check', sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`),
    check('platform_jobs_payload_check', sql`jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 1024`),
    check('platform_jobs_attempts_check', sql`${table.attempts} >= 0 AND ${table.maxAttempts} BETWEEN 1 AND 25 AND ${table.attempts} <= ${table.maxAttempts}`),
    // A lease exists exactly while RUNNING.
    check(
      'platform_jobs_lease_check',
      sql`(${table.status} = 'RUNNING') = (${table.leaseId} IS NOT NULL AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
          AND (${table.leaseId} IS NULL) = (${table.leaseOwner} IS NULL) AND (${table.leaseId} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
    check('platform_jobs_finished_check', sql`(${table.status} IN ('SUCCEEDED','DEAD')) = (${table.finishedAt} IS NOT NULL)`),
    check('platform_jobs_failure_class_check', sql`${table.lastFailureClass} IS NULL OR ${table.lastFailureClass} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    // Claim scan: due work in run_after order.
    index('platform_jobs_due_idx').on(table.status, table.runAfter),
  ],
);
