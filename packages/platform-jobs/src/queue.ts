import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { FAILURE_CLASS, IdempotencyConflictError, InvalidJobError, sanitizeStoreErrors } from './errors.js';
import { validatePayload, type JobPayload, type JobRegistry } from './registry.js';
import type { Database } from './postgres/client.js';
import { platformJobs as jobs } from './postgres/schema.js';

export type JobStatus = 'PENDING' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCEEDED' | 'DEAD';

export interface EnqueueInput {
  type: string;
  organizationId?: string | null;
  /** Deterministic per logical job, e.g. `<schedule>:<period>:<target>`. Re-enqueueing the same key never creates a second job. */
  idempotencyKey: string;
  payload: JobPayload;
  runAfter?: Date;
}

/** A claimed job. `leaseId` is the fencing token: every renew/complete/fail must present it. */
export interface ClaimedJob {
  jobId: string;
  jobType: string;
  organizationId: string | null;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  leaseId: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 3_600_000;

function assertLease(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < MIN_LEASE_MS || ms > MAX_LEASE_MS) throw new InvalidJobError('leaseMs');
}

const canonical = (p: Record<string, unknown>) => JSON.stringify(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)));

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  /** Fraction of the delay randomized either way, e.g. 0.2 → ±20%. */
  jitter: number;
}
export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 30_000, maxMs: 3_600_000, jitter: 0.2 };

/** Exponential backoff with bounded jitter: base·2^(attempt−1), ±jitter, never above maxMs. `random` is injectable for tests. */
export function backoffMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.min(policy.maxMs, exponential * (1 - policy.jitter + 2 * policy.jitter * random())));
}

/**
 * The durable queue (ARCH-021). Every state transition is one conditional
 * statement here — there is no general "set status" path:
 *
 *   PENDING ─claim→ RUNNING ─complete→ SUCCEEDED
 *   RUNNING ─fail(retryable, attempts left)→ RETRY_WAIT ─claim (run_after due)→ RUNNING
 *   RUNNING ─fail(permanent | attempts exhausted)→ DEAD
 *   RUNNING with an expired lease ─claim→ RUNNING (new lease) | DEAD if attempts exhausted
 *
 * The database clock (`now()`) is the only clock used for eligibility and
 * leases. Delivery is at-least-once: consumers must make effects idempotent.
 */
export class JobQueue {
  constructor(
    private readonly db: Database,
    private readonly registry: JobRegistry,
  ) {}

  /** Idempotent: an existing identical job is returned (`created: false`); a different job under the same key is an error. */
  async enqueue(input: EnqueueInput): Promise<{ jobId: string; created: boolean }> {
    const definition = this.registry.get(input.type);
    const organizationId = input.organizationId ?? null;
    if ((definition.scope === 'organization') !== (organizationId !== null)) throw new InvalidJobError('organizationId');
    if (organizationId !== null && !ID.test(organizationId)) throw new InvalidJobError('organizationId');
    if (typeof input.idempotencyKey !== 'string' || !KEY.test(input.idempotencyKey)) throw new InvalidJobError('idempotencyKey');
    const payload = validatePayload(definition, input.payload);

    return sanitizeStoreErrors(async () => {
      const [inserted] = await this.db
        .insert(jobs)
        .values({
          jobId: randomUUID(),
          jobType: definition.type,
          organizationId,
          idempotencyKey: input.idempotencyKey,
          payload,
          status: 'PENDING',
          maxAttempts: definition.maxAttempts,
          ...(input.runAfter ? { runAfter: input.runAfter } : {}),
        })
        .onConflictDoNothing({ target: [jobs.jobType, jobs.idempotencyKey] })
        .returning({ jobId: jobs.jobId });
      if (inserted) return { jobId: inserted.jobId, created: true };

      const [existing] = await this.db
        .select({ jobId: jobs.jobId, organizationId: jobs.organizationId, payload: jobs.payload })
        .from(jobs)
        .where(and(eq(jobs.jobType, definition.type), eq(jobs.idempotencyKey, input.idempotencyKey)));
      if (!existing || existing.organizationId !== organizationId || canonical(existing.payload) !== canonical(payload)) throw new IdempotencyConflictError();
      return { jobId: existing.jobId, created: false };
    });
  }

  /**
   * Claims the next due job with `FOR UPDATE SKIP LOCKED`, in one statement:
   * PENDING/RETRY_WAIT whose run_after has passed, or RUNNING whose lease
   * expired (crash recovery). Expired leases with no attempts left become DEAD
   * first, so a job that keeps killing its worker cannot loop forever.
   */
  async claim(workerId: string, leaseMs: number, types?: readonly string[]): Promise<ClaimedJob | null> {
    if (!ID.test(workerId)) throw new InvalidJobError('workerId');
    assertLease(leaseMs);
    const typeFilter = types ? sql`and job_type = any(${sql.param([...types])}::text[])` : sql``;
    return sanitizeStoreErrors(async () => {
      await this.db.execute(sql`
        update platform_jobs
           set status = 'DEAD', last_failure_class = 'lease_expired', lease_id = null, lease_owner = null, lease_expires_at = null,
               finished_at = now(), updated_at = now()
         where job_id in (select job_id from platform_jobs
                           where status = 'RUNNING' and lease_expires_at <= now() and attempts >= max_attempts
                           for update skip locked)`);
      const leaseId = randomUUID();
      const result = await this.db.execute(sql`
        update platform_jobs j
           set status = 'RUNNING', attempts = j.attempts + 1, lease_id = ${leaseId}::uuid, lease_owner = ${workerId},
               lease_expires_at = now() + ${leaseMs}::int * interval '1 millisecond', started_at = now(), updated_at = now()
          from (select job_id from platform_jobs
                 where ((status in ('PENDING', 'RETRY_WAIT') and run_after <= now())
                        or (status = 'RUNNING' and lease_expires_at <= now() and attempts < max_attempts))
                   ${typeFilter}
                 order by run_after, job_id
                 limit 1
                 for update skip locked) due
         where j.job_id = due.job_id
        returning j.job_id, j.job_type, j.organization_id, j.payload, j.attempts, j.max_attempts`);
      const row = result.rows[0] as
        | { job_id: string; job_type: string; organization_id: string | null; payload: Record<string, unknown>; attempts: number; max_attempts: number }
        | undefined;
      if (!row) return null;
      return {
        jobId: row.job_id,
        jobType: row.job_type,
        organizationId: row.organization_id,
        payload: row.payload,
        attempt: row.attempts,
        maxAttempts: row.max_attempts,
        leaseId,
      };
    });
  }

  /** Extends the lease. False when the lease is no longer this worker's (reclaimed, completed or failed). */
  async renew(jobId: string, leaseId: string, leaseMs: number): Promise<boolean> {
    assertLease(leaseMs);
    return sanitizeStoreErrors(async () => {
      const r = await this.db.execute(sql`
        update platform_jobs set lease_expires_at = now() + ${leaseMs}::int * interval '1 millisecond', updated_at = now()
         where job_id = ${jobId}::uuid and lease_id = ${leaseId}::uuid and status = 'RUNNING'`);
      return r.rowCount === 1;
    });
  }

  /** RUNNING → SUCCEEDED, only for the current lease holder. False for a stale worker. */
  async complete(jobId: string, leaseId: string): Promise<boolean> {
    return sanitizeStoreErrors(async () => {
      const r = await this.db.execute(sql`
        update platform_jobs
           set status = 'SUCCEEDED', lease_id = null, lease_owner = null, lease_expires_at = null, finished_at = now(), updated_at = now()
         where job_id = ${jobId}::uuid and lease_id = ${leaseId}::uuid and status = 'RUNNING'`);
      return r.rowCount === 1;
    });
  }

  /**
   * RUNNING → RETRY_WAIT (retryable, attempts left; run_after = now + delay) or
   * DEAD (permanent, or attempts exhausted), only for the current lease holder.
   * Returns the new status, or null for a stale worker.
   */
  async fail(jobId: string, leaseId: string, kind: 'retryable' | 'permanent', failureClass: string, retryDelayMs: number): Promise<'RETRY_WAIT' | 'DEAD' | null> {
    if (!FAILURE_CLASS.test(failureClass)) throw new InvalidJobError('failureClass');
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > DEFAULT_BACKOFF.maxMs * 24) throw new InvalidJobError('retryDelayMs');
    const retry = sql`(${kind}::text = 'retryable' and attempts < max_attempts)`;
    return sanitizeStoreErrors(async () => {
      const r = await this.db.execute(sql`
        update platform_jobs
           set status = case when ${retry} then 'RETRY_WAIT' else 'DEAD' end,
               run_after = case when ${retry} then now() + ${retryDelayMs}::int * interval '1 millisecond' else run_after end,
               finished_at = case when ${retry} then null else now() end,
               last_failure_class = ${failureClass}, lease_id = null, lease_owner = null, lease_expires_at = null, updated_at = now()
         where job_id = ${jobId}::uuid and lease_id = ${leaseId}::uuid and status = 'RUNNING'
        returning status`);
      return ((r.rows[0] as { status: 'RETRY_WAIT' | 'DEAD' } | undefined)?.status) ?? null;
    });
  }

  /** Operational metadata per job type — counts, ages, stale leases, failure classes. Never payloads or organization IDs. */
  async stats(): Promise<JobTypeStats[]> {
    return sanitizeStoreErrors(async () => {
      const r = await this.db.execute(sql`
        select job_type,
               count(*) filter (where status = 'PENDING')::int as pending,
               count(*) filter (where status = 'RUNNING')::int as running,
               count(*) filter (where status = 'RETRY_WAIT')::int as retry_wait,
               count(*) filter (where status = 'SUCCEEDED')::int as succeeded,
               count(*) filter (where status = 'DEAD')::int as dead,
               count(*) filter (where status = 'RUNNING' and lease_expires_at <= now())::int as stale_leases,
               coalesce(extract(epoch from now() - min(run_after) filter (where status in ('PENDING', 'RETRY_WAIT') and run_after <= now())), 0)::int as oldest_due_seconds,
               min(run_after) filter (where status in ('PENDING', 'RETRY_WAIT') and run_after > now()) as next_run_after,
               coalesce(max(attempts) filter (where status not in ('SUCCEEDED', 'DEAD')), 0)::int as max_active_attempts,
               coalesce(jsonb_object_agg(last_failure_class, 1) filter (where status = 'DEAD' and last_failure_class is not null), '{}'::jsonb) as dead_failure_classes
          from platform_jobs group by job_type order by job_type`);
      return (r.rows as Record<string, unknown>[]).map((x) => ({
        jobType: String(x.job_type),
        pending: Number(x.pending),
        running: Number(x.running),
        retryWait: Number(x.retry_wait),
        succeeded: Number(x.succeeded),
        dead: Number(x.dead),
        staleLeases: Number(x.stale_leases),
        oldestDueSeconds: Number(x.oldest_due_seconds),
        nextRunAfter: x.next_run_after ? new Date(String(x.next_run_after)).toISOString() : null,
        maxActiveAttempts: Number(x.max_active_attempts),
        deadFailureClasses: Object.keys(x.dead_failure_classes as Record<string, unknown>).sort(),
      }));
    });
  }
}

export interface JobTypeStats {
  jobType: string;
  pending: number;
  running: number;
  retryWait: number;
  succeeded: number;
  dead: number;
  staleLeases: number;
  oldestDueSeconds: number;
  nextRunAfter: string | null;
  maxActiveAttempts: number;
  deadFailureClasses: string[];
}
