import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JobFailure, JobRegistry, type JobContext } from '@samvardiq/platform-jobs';

import { RETENTION_PURGE_JOB_TYPE, RETENTION_PURGE_MAX_ATTEMPTS, RETENTION_PURGE_PERIOD_MS, retentionPurgeJob, retentionPurgeSchedule } from '../src/retentionMaintenance.js';
import type { RetentionPurgeRepository } from '../src/retention.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const ctx = (organizationId: string | null): JobContext => ({ jobId: 'j', jobType: RETENTION_PURGE_JOB_TYPE, organizationId, payload: {}, attempt: 1, signal: new AbortController().signal });

/** A capability that throws on ANY member other than purgeExpired — proves what the handler can reach. */
function narrowSpy(calls: [string, Date][]): RetentionPurgeRepository {
  return new Proxy({} as RetentionPurgeRepository, {
    get(_t, prop) {
      if (prop === 'purgeExpired') return async (organizationId: string, now: Date) => (calls.push([organizationId, now]), 3);
      if (prop === 'then') return undefined;
      throw new Error(`maintenance handler touched ${String(prop)}`);
    },
  });
}

test('18: the maintenance handler reaches exactly one capability — purgeExpired for the job`s own organization — and nothing else', async () => {
  const calls: [string, Date][] = [];
  const job = retentionPurgeJob({ purge: narrowSpy(calls), now: () => NOW });
  await job.handle(ctx('org-a'));
  assert.deepEqual(calls, [['org-a', NOW]]);
  assert.equal(job.handle.length, 1, 'the handler receives only the job context');
});

test('the job type is identifiers-only (empty payload), organization-targeted and bounded; it registers cleanly', () => {
  const job = retentionPurgeJob({ purge: narrowSpy([]) });
  assert.deepEqual([job.type, job.scope, job.payload, job.maxAttempts], ['communication.retention_purge', 'organization', {}, RETENTION_PURGE_MAX_ATTEMPTS]);
  assert.doesNotThrow(() => new JobRegistry().register(job));
});

test('a job without a target organization is a permanent failure — it never falls back to "all organizations"', async () => {
  const calls: [string, Date][] = [];
  await assert.rejects(retentionPurgeJob({ purge: narrowSpy(calls) }).handle(ctx(null)), (e: unknown) => e instanceof JobFailure && e.kind === 'permanent' && e.failureClass === 'invalid_scope');
  assert.equal(calls.length, 0);
});

test('16: a failing purge (whose error text could carry content) surfaces only a fixed retryable class', async () => {
  const leaking: RetentionPurgeRepository = {
    async purgeExpired() {
      throw new Error('Failed query: delete ... raw_text = "patient Ravi has chest pain +919999999999"');
    },
  };
  await assert.rejects(retentionPurgeJob({ purge: leaking }).handle(ctx('org-a')), (e: unknown) => {
    assert.ok(e instanceof JobFailure);
    assert.deepEqual([e.kind, e.failureClass, e.message], ['retryable', 'retention_purge_failed', 'Job failed (retryable).']);
    assert.equal((e as Error).cause, undefined);
    return true;
  });
});

test('the schedule is hourly and targets every enumerated organization with an empty payload', async () => {
  const schedule = retentionPurgeSchedule({ organizations: { listOrganizationIdsWithChannels: async () => ['org-a', 'org-b'] } });
  assert.equal(schedule.periodMs, RETENTION_PURGE_PERIOD_MS);
  assert.equal(RETENTION_PURGE_PERIOD_MS, 3_600_000);
  assert.deepEqual(await schedule.targets({ start: NOW }), [
    { organizationId: 'org-a', key: 'org-a', payload: {} },
    { organizationId: 'org-b', key: 'org-b', payload: {} },
  ]);
});
