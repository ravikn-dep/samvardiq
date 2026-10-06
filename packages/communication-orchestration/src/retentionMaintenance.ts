import { JobFailure, type JobDefinition, type ScheduleDefinition } from '@samvardiq/platform-jobs';

import type { RetentionPurgeRepository } from './retention.js';

/**
 * PLATFORM-JOBS-W1 — communication raw-message retention as MANDATORY
 * PLATFORM MAINTENANCE (Founder decision, 2026-10-06; ARCH-021 platform
 * maintenance category).
 *
 * The purge enforces Founder CLINIC-W2 Decision 2 (raw content kept at most
 * 30 days; `purge_after` is set at write time) and therefore does NOT depend
 * on any channel service principal, automation being enabled, the channel
 * being enabled or the organization being active. Its authority is narrow and
 * structural:
 *
 * - the handler holds exactly one capability, `RetentionPurgeRepository.purgeExpired`
 *   — no TrustedOrganizationContext is ever constructed, so no organization
 *   business operation is reachable from here;
 * - each job targets exactly one organization and `purgeExpired` runs under
 *   that organization's RLS context (FORCE RLS on `communication_message_content`);
 * - what is eligible (only rows whose `purge_after` has passed) is decided by
 *   the communication domain, never by the job.
 *
 * The job carries no payload at all: the organization is the job's target
 * column and the hourly period lives only in the idempotency key.
 */
export const RETENTION_PURGE_JOB_TYPE = 'communication.retention_purge';

/**
 * Hourly. `purge_after` is exactly 30 days after receipt, so content becomes
 * eligible at the 30-day boundary and is deleted at the next run: under
 * normal operation within about one hour of it (plus retry backoff on a
 * transient failure). A 30-day maximum with a zero-margin `purge_after`
 * cannot be met with margin by any cadence — tightening that would be a
 * retention-policy change, not a scheduling one.
 */
export const RETENTION_PURGE_PERIOD_MS = 3_600_000;

/** Bounded retries; a DEAD run is superseded by the next hour's run, which deletes everything already past `purge_after`. */
export const RETENTION_PURGE_MAX_ATTEMPTS = 5;

/** Identifiers of every organization that can hold purgeable content (see PostgresCommunicationChannelRepository). */
export interface RetentionOrganizationSource {
  listOrganizationIdsWithChannels(): Promise<string[]>;
}

export function retentionPurgeJob(deps: { purge: RetentionPurgeRepository; now?: () => Date }): JobDefinition {
  const { purge } = deps;
  const now = deps.now ?? (() => new Date());
  return {
    type: RETENTION_PURGE_JOB_TYPE,
    scope: 'organization',
    payload: {},
    maxAttempts: RETENTION_PURGE_MAX_ATTEMPTS,
    async handle(job) {
      if (!job.organizationId) throw new JobFailure('permanent', 'invalid_scope');
      try {
        await purge.purgeExpired(job.organizationId, now());
      } catch {
        // The cause (e.g. a database error) is never persisted; the next attempt or the next hourly run retries.
        throw new JobFailure('retryable', 'retention_purge_failed');
      }
    },
  };
}

export function retentionPurgeSchedule(deps: { organizations: RetentionOrganizationSource }): ScheduleDefinition {
  return {
    name: 'communication_retention',
    jobType: RETENTION_PURGE_JOB_TYPE,
    periodMs: RETENTION_PURGE_PERIOD_MS,
    async targets() {
      const organizationIds = await deps.organizations.listOrganizationIdsWithChannels();
      return organizationIds.map((organizationId) => ({ organizationId, key: organizationId, payload: {} }));
    },
  };
}
