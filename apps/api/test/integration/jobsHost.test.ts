import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { createPostgresClient as createCommsClient, PostgresCommunicationChannelRepository, PostgresMessageContentRepository } from '@samvardiq/communication-orchestration/dist/postgres/index.js';
import { retentionPurgeJob, retentionPurgeSchedule } from '@samvardiq/communication-orchestration';
import { createPostgresClient as createJobsClient, JobQueue, JobRegistry } from '@samvardiq/platform-jobs';

import { startJobsHost, type JobsHostLogger } from '../../src/jobsHost.js';
import { startLocalSupabaseCluster, type LocalSupabaseCluster } from '../../scripts/localSupabaseCluster.js';

/**
 * PLATFORM-JOBS-W1 hosting Option A against a migrated AND hardened
 * Supabase-shaped cluster (platform_jobs carries the samvardiq_app-scoped
 * platform-global policy, exactly as on staging), as the runtime role.
 */
let cluster: LocalSupabaseCluster;
let comms: ReturnType<typeof createCommsClient>;
let jobs: ReturnType<typeof createJobsClient>;
const SENSITIVE = 'SYNTHETIC-RAW-TEXT chest pain +919999999999';

before(async () => {
  cluster = await startLocalSupabaseCluster(55965, { migrate: true, harden: true });
  comms = createCommsClient({ connectionString: cluster.appUrl, max: 4 });
  jobs = createJobsClient({ connectionString: cluster.appUrl, max: 4 });
});
after(async () => {
  await Promise.allSettled([comms.close(), jobs.close()]);
  await cluster.stop();
});
beforeEach(async () => {
  await cluster.owner.pool.query('TRUNCATE platform_jobs, communication_message_content, communication_channels');
});

const q = (text: string, params: unknown[] = []) => cluster.owner.pool.query(text, params);
async function seed(org: string, offsetsDays: number[]) {
  await q(
    `insert into communication_channels (organization_id, channel_id, provider, external_channel_id, service_identity_id, service_provider_subject, access_token_reference, display_phone_number, timezone, enabled)
     values ($1, $2, 'meta_whatsapp_cloud_api', $3, 'svc', $2, 'env:NONE', '+000', 'Asia/Kolkata', false)`,
    [org, `chan-${org}`, `ext-${org}`],
  );
  for (const [i, d] of offsetsDays.entries()) {
    await q(`insert into communication_message_content (organization_id, message_id, raw_text, purge_after) values ($1, $2, $3, now() + $4 * interval '1 day')`, [org, `m-${org}-${i}`, SENSITIVE, d]);
  }
}
const count = async (sql: string) => Number((await q(sql)).rows[0].n);
function host(worker: boolean, scheduler: boolean, logs: unknown[] = [], db = jobs.db) {
  const registry = new JobRegistry().register(retentionPurgeJob({ purge: new PostgresMessageContentRepository(comms.db) }));
  const log: JobsHostLogger = { info: (o, m) => void logs.push([m, o]), warn: (o, m) => void logs.push([m, o]) };
  return startJobsHost({
    worker,
    scheduler,
    queue: new JobQueue(db, registry),
    registry,
    schedules: [retentionPurgeSchedule({ organizations: new PostgresCommunicationChannelRepository(comms.db) })],
    log,
    workerPollMs: 50,
    schedulerIntervalMs: 100,
    leaseMs: 30_000,
  });
}
async function until(predicate: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('condition not reached in time');
}

test('both flags off: nothing starts — no job is ever created or claimed', async () => {
  await seed('org-a', [-1]);
  const h = host(false, false);
  assert.equal(h.workerId, null);
  await new Promise((r) => setTimeout(r, 500));
  await h.stop();
  assert.equal(await count(`select count(*)::int as n from platform_jobs`), 0);
  assert.equal(await count(`select count(*)::int as n from communication_message_content`), 1);
});

test('the flags are independent: scheduler-only enqueues and claims nothing; worker-only executes and enqueues nothing', async () => {
  await seed('org-a', [-1, 1]);
  const s = host(false, true);
  await until(async () => (await count(`select count(*)::int as n from platform_jobs`)) === 1);
  await new Promise((r) => setTimeout(r, 400)); // several more ticks in the same hour
  await s.stop();
  assert.equal(await count(`select count(*)::int as n from platform_jobs where status = 'PENDING' and attempts = 0`), 1, 'enqueued once, never claimed');
  const w = host(true, false);
  await until(async () => (await count(`select count(*)::int as n from platform_jobs where status = 'SUCCEEDED'`)) === 1);
  await w.stop();
  assert.equal(await count(`select count(*)::int as n from platform_jobs`), 1, 'the worker enqueued nothing');
  assert.equal(await count(`select count(*)::int as n from communication_message_content`), 1, 'expired row purged, future row kept');
});

test('two fully enabled hosts on one database (multi-replica): one logical job per organization, each executed exactly once', async () => {
  for (const org of ['org-a', 'org-b', 'org-c']) await seed(org, [-3, -1, 2]);
  const logs: unknown[] = [];
  const [h1, h2] = [host(true, true, logs), host(true, true, logs)];
  await until(async () => (await count(`select count(*)::int as n from platform_jobs where status = 'SUCCEEDED'`)) === 3);
  await new Promise((r) => setTimeout(r, 400)); // more ticks from both hosts in the same hour
  await Promise.all([h1.stop(), h2.stop()]);
  assert.equal(await count(`select count(*)::int as n from platform_jobs`), 3);
  assert.equal(await count(`select count(*)::int as n from platform_jobs where attempts = 1 and status = 'SUCCEEDED'`), 3, 'no job ran twice');
  assert.equal(await count(`select count(distinct organization_id)::int as n from platform_jobs`), 3);
  assert.equal(await count(`select count(*)::int as n from communication_message_content`), 3, 'only the future row of each organization remains');
  const keys = (await q(`select idempotency_key from platform_jobs order by 1`)).rows.map((r) => r.idempotency_key);
  assert.ok(keys.every((k: string) => /^communication_retention:\d{4}-\d{2}-\d{2}T\d{2}:00:00Z:org-[abc]$/.test(k)), keys.join(','));
  assert.equal(await count(`select count(*)::int as n from platform_jobs where payload <> '{}'::jsonb`), 0);
  const text = JSON.stringify(logs);
  for (const s of ['SYNTHETIC-RAW-TEXT', 'chest pain', '+919999999999']) assert.ok(!text.includes(s));
});

test('stop(): no further tick or claim after shutdown; durable state is untouched', async () => {
  await seed('org-a', [-1]);
  const h = host(true, true);
  await until(async () => (await count(`select count(*)::int as n from platform_jobs where status = 'SUCCEEDED'`)) === 1);
  await h.stop();
  await new JobQueue(jobs.db, new JobRegistry().register(retentionPurgeJob({ purge: new PostgresMessageContentRepository(comms.db) }))).enqueue({
    type: 'communication.retention_purge',
    organizationId: 'org-a',
    idempotencyKey: 'after-stop',
    payload: {},
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await count(`select count(*)::int as n from platform_jobs where idempotency_key = 'after-stop' and status = 'PENDING'`), 1, 'not claimed after stop');
  assert.equal(await count(`select count(*)::int as n from platform_jobs`), 2, 'no tick after stop');
});

test('loop failure isolation: with the database unreachable the host keeps running, logs only sanitized codes, and stops cleanly', async () => {
  await seed('org-a', [-1]); // a target exists, so the tick really attempts an enqueue against the unreachable queue
  const down = createJobsClient({ connectionString: 'postgres://samvardiq_app:not-the-password@localhost:1/none', connectionTimeoutMillis: 200 });
  const logs: [string, Record<string, unknown>][] = [];
  try {
    const h = host(true, true, logs as unknown[], down.db);
    await new Promise((r) => setTimeout(r, 800));
    await h.stop();
  } finally {
    await down.close();
  }
  const warnings = logs.filter(([m]) => m !== 'jobs worker started' && m !== 'jobs scheduler started');
  assert.ok(warnings.some(([m]) => m === 'jobs schedule tick failed') && warnings.some(([m]) => m === 'job not completed'));
  assert.ok(JSON.stringify(warnings).length > 0 && !JSON.stringify(warnings).includes('not-the-password') && !JSON.stringify(warnings).includes('localhost'));
  for (const [, o] of warnings) assert.ok(Object.keys(o).every((k) => ['errorCode', 'outcome'].includes(k)), JSON.stringify(o));
});
