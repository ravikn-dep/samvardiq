import assert from 'node:assert/strict';
import path from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';

import { runMigrations as migrateDataFoundation } from '@samvardiq/data-foundation/dist/postgres/client.js';
import { runMigrations as migrateIdentity } from '@samvardiq/identity-access/dist/postgres/client.js';
import {
  createPostgresClient as createJobsClient,
  JobQueue,
  JobRegistry,
  JobWorker,
  runMigrations as migrateJobs,
  runScheduleTick,
  type PostgresClient as JobsClient,
  type WorkerEvent,
} from '@samvardiq/platform-jobs';

import { PostgresCommunicationChannelRepository } from '../../src/postgres/channelRepository.js';
import { PostgresMessageContentRepository } from '../../src/postgres/messageContentRepository.js';
import { RETENTION_PURGE_JOB_TYPE, RETENTION_PURGE_MAX_ATTEMPTS, retentionPurgeJob, retentionPurgeSchedule } from '../../src/retentionMaintenance.js';
import type { RetentionPurgeRepository } from '../../src/retention.js';
import { startHarness, type Harness } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(__dirname, `../../../${name}/drizzle`);

const NOW = new Date('2026-10-06T12:00:00.000Z');
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const SENSITIVE = 'RAW-PATIENT-TEXT chest pain call +919999999999';

describe('communication retention purge as platform maintenance (real PostgreSQL)', () => {
  let h: Harness;
  let jobsDb: JobsClient;

  before(async () => {
    h = await startHarness(55995);
    await migrateDataFoundation(h.owner.db as never, pkg('data-foundation'));
    await migrateIdentity(h.owner.db as never, pkg('identity-access'));
    await migrateJobs(h.owner.db as never, pkg('platform-jobs'));
    const appUrl = (h.app.pool as unknown as { options: { connectionString: string } }).options.connectionString;
    jobsDb = createJobsClient({ connectionString: appUrl, max: 20 });
  });
  after(async () => {
    await jobsDb.close();
    await h.stop();
  });
  beforeEach(async () => {
    await h.truncateAll();
    await h.owner.pool.query('TRUNCATE platform_jobs, organization_memberships, identity_provider_links, identities, organizations CASCADE');
  });

  const purgeRepo = () => new PostgresMessageContentRepository(h.app.db);
  const channels = () => new PostgresCommunicationChannelRepository(h.app.db);
  const setup = (purge: RetentionPurgeRepository = purgeRepo(), now = () => NOW) => {
    const registry = new JobRegistry().register(retentionPurgeJob({ purge, now }));
    const queue = new JobQueue(jobsDb.db, registry);
    return { registry, queue, schedule: retentionPurgeSchedule({ organizations: channels() }) };
  };
  const drain = async (queue: JobQueue, registry: JobRegistry, events?: WorkerEvent[]) => {
    const w = new JobWorker(queue, registry, { workerId: 'w-test', leaseMs: 30_000, random: () => 0.5, onEvent: events ? (e) => events.push(e) : undefined });
    const outcomes: string[] = [];
    for (let o = await w.runOnce(); o !== 'idle'; o = await w.runOnce()) outcomes.push(o);
    return outcomes;
  };

  /** One organization's communication data: a channel, conversation, messages, a handoff event, and raw content rows at the given purge_after offsets. */
  async function seedOrg(org: string, offsets: number[], opts: { channelEnabled?: boolean } = {}) {
    const q = (text: string, params: unknown[]) => h.owner.pool.query(text, params);
    await q(
      `insert into communication_channels (organization_id, channel_id, provider, external_channel_id, service_identity_id, service_provider_subject, access_token_reference, display_phone_number, timezone, enabled)
       values ($1, $2, 'meta_whatsapp_cloud_api', $3, $4, $2, 'env:NONE', '+000', 'Asia/Kolkata', $5)`,
      [org, `chan-${org}`, `ext-${org}`, `svc-whatsapp-chan-${org}`, opts.channelEnabled ?? true],
    );
    await q(
      `insert into conversations (organization_id, conversation_id, channel_id, external_contact_id, state, preferred_language, booking_state, handoff_owner_identity_id, handoff_claimed_at)
       values ($1, $2, $3, 'contact', 'HUMAN_ACTIVE', 'en-IN', 'NEW', 'staff', now())`,
      [org, `conv-${org}`, `chan-${org}`],
    );
    await q(`insert into conversation_handoffs (organization_id, handoff_id, conversation_id, event_type, actor_identity_id, actor_principal_type) values ($1, $2, $3, 'CLAIMED', 'staff', 'human')`, [org, `ho-${org}`, `conv-${org}`]);
    for (const [i, offset] of offsets.entries()) {
      await q(`insert into communication_messages (organization_id, message_id, conversation_id, direction, message_type) values ($1, $2, $3, 'INBOUND', 'text')`, [org, `m-${org}-${i}`, `conv-${org}`]);
      await q(`insert into communication_message_content (organization_id, message_id, raw_text, purge_after) values ($1, $2, $3, $4)`, [org, `m-${org}-${i}`, `${SENSITIVE} ${i}`, at(offset)]);
    }
  }
  const contentIds = async (org: string) => (await h.owner.pool.query(`select message_id from communication_message_content where organization_id = $1 order by 1`, [org])).rows.map((r) => r.message_id);
  const count = async (table: string, org?: string) => Number((await h.owner.pool.query(`select count(*)::int as n from ${table}${org ? ' where organization_id = $1' : ''}`, org ? [org] : [])).rows[0].n);
  const job = async (org: string) => (await h.owner.pool.query(`select * from platform_jobs where organization_id = $1`, [org])).rows[0];

  test('3/AS/AU/10/11: a normal run deletes exactly the rows at/past purge_after; future rows and all metadata/audit survive; the boundary is deterministic', async () => {
    await seedOrg('org-a', [-40 * DAY, -1, 0, 1, 10 * DAY]); // 0 = exactly at boundary (deleted: purge_after <= now); +1 ms survives
    const { queue, registry, schedule } = setup();
    assert.deepEqual(await runScheduleTick(queue, [schedule], NOW), { enqueued: 1, existing: 0 });
    assert.deepEqual(await drain(queue, registry), ['SUCCEEDED']);
    assert.deepEqual(await contentIds('org-a'), ['m-org-a-3', 'm-org-a-4'], 'AS/10: +1 ms and +10 days survive; -40 d, -1 ms and exactly-now are purged');
    assert.equal(await count('communication_messages', 'org-a'), 5, 'AU: message metadata retained');
    assert.equal(await count('conversations', 'org-a'), 1);
    assert.equal(await count('conversation_handoffs', 'org-a'), 1, 'AU: handoff audit retained');
    assert.equal(await count('communication_channels'), 1);
  });

  test('AJ/2: an INACTIVE organization`s expired content is still purged', async () => {
    await h.owner.pool.query(`insert into organizations (organization_id, organization_type, name, status) values ('org-a', 'clinic', 'Inactive Clinic', 'inactive')`);
    await seedOrg('org-a', [-DAY, DAY]);
    const { queue, registry, schedule } = setup();
    await runScheduleTick(queue, [schedule], NOW);
    assert.deepEqual(await drain(queue, registry), ['SUCCEEDED']);
    assert.deepEqual(await contentIds('org-a'), ['m-org-a-1']);
  });

  test('AK/1/4/5: a DISABLED channel whose service principal is SUSPENDED (identity and membership) — or does not exist at all — does not stop the purge', async () => {
    await seedOrg('org-a', [-DAY, DAY], { channelEnabled: false });
    await h.owner.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('svc-whatsapp-chan-org-a', 'service', 'svc', 'suspended')`);
    await h.owner.pool.query(`insert into organization_memberships (organization_id, identity_id, role, status) values ('org-a', 'svc-whatsapp-chan-org-a', 'MEMBER', 'SUSPENDED')`);
    await seedOrg('org-b', [-DAY, DAY]); // no service identity provisioned at all
    const { queue, registry, schedule } = setup();
    assert.deepEqual(await runScheduleTick(queue, [schedule], NOW), { enqueued: 2, existing: 0 }, 'disabled channels are enumerated');
    assert.deepEqual(await drain(queue, registry), ['SUCCEEDED', 'SUCCEEDED']);
    assert.deepEqual(await contentIds('org-a'), ['m-org-a-1']);
    assert.deepEqual(await contentIds('org-b'), ['m-org-b-1']);
  });

  test('AL/AT/6: each job purges exactly its own organization; the RLS context refuses any cross-organization delete', async () => {
    for (const org of ['org-a', 'org-b', 'org-c']) await seedOrg(org, [-DAY, -2 * DAY, DAY]);
    const { queue, registry } = setup();
    await queue.enqueue({ type: RETENTION_PURGE_JOB_TYPE, organizationId: 'org-a', idempotencyKey: 'only-a', payload: {} });
    assert.deepEqual(await drain(queue, registry), ['SUCCEEDED']);
    assert.deepEqual(await contentIds('org-a'), ['m-org-a-2']);
    assert.equal((await contentIds('org-b')).length, 3, 'AT: org B untouched by org A`s job');
    assert.equal((await contentIds('org-c')).length, 3);
    // AL: even a direct attempt from org A's RLS context deletes nothing of org B.
    const client = await h.app.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select set_config('app.current_org_id', 'org-a', true)`);
      assert.equal((await client.query(`delete from communication_message_content where organization_id = 'org-b'`)).rowCount, 0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    // 6: multiple organizations due at once, drained concurrently, each isolated.
    const { schedule } = setup();
    await runScheduleTick(queue, [schedule], NOW);
    await Promise.all(Array.from({ length: 6 }, (_, i) => new JobWorker(queue, registry, { workerId: `w-${i}`, leaseMs: 30_000 }).runOnce()));
    for (const org of ['org-a', 'org-b', 'org-c']) assert.deepEqual(await contentIds(org), [`m-${org}-2`]);
  });

  test('AQ/AR: running the purge twice, or with nothing eligible, is a safe no-op', async () => {
    await seedOrg('org-a', [-DAY, DAY]);
    const { queue, registry } = setup();
    for (const key of ['run-1', 'run-2', 'run-3']) await queue.enqueue({ type: RETENTION_PURGE_JOB_TYPE, organizationId: 'org-a', idempotencyKey: key, payload: {} });
    assert.deepEqual(await drain(queue, registry), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    assert.deepEqual(await contentIds('org-a'), ['m-org-a-1']);
    assert.equal(await purgeRepo().purgeExpired('org-a', NOW), 0, 'AR: nothing eligible → 0');
    assert.equal(await purgeRepo().purgeExpired('org-without-data', NOW), 0);
  });

  test('9/AG: after a prolonged scheduler outage the next single run purges everything already past purge_after', async () => {
    await seedOrg('org-a', [-30 * DAY, -10 * DAY, -3 * DAY, -1 * DAY, -60_000, DAY]);
    const { queue, registry, schedule } = setup();
    // No tick ran for ~30 days; the first tick after the outage enqueues only the current hour.
    assert.deepEqual(await runScheduleTick(queue, [schedule], NOW), { enqueued: 1, existing: 0 });
    assert.deepEqual(await drain(queue, registry), ['SUCCEEDED']);
    assert.deepEqual(await contentIds('org-a'), ['m-org-a-5'], 'the whole backlog is gone; only the future row remains');
  });

  test('12: repeated and 10 concurrent ticks in one hour create one logical purge job per organization', async () => {
    for (const org of ['org-a', 'org-b']) await seedOrg(org, [-DAY]);
    const { queue, schedule } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => runScheduleTick(queue, [schedule], new Date(NOW.getTime() + i * 60_000))));
    assert.equal(results.reduce((n, r) => n + r.enqueued, 0), 2);
    assert.equal(await count('platform_jobs'), 2);
    await runScheduleTick(queue, [schedule], at(3_600_000));
    assert.equal(await count('platform_jobs'), 4, 'the next hour is a new logical job');
  });

  test('13/14: 10 concurrent workers execute one purge job once; a stale worker cannot mark reclaimed purge work successful', async () => {
    await seedOrg('org-a', [-DAY, DAY]);
    let calls = 0;
    const real = purgeRepo();
    const counting: RetentionPurgeRepository = { purgeExpired: (o, n) => ((calls += 1), real.purgeExpired(o, n)) };
    const { queue, registry, schedule } = setup(counting);
    await runScheduleTick(queue, [schedule], NOW);
    const outcomes = await Promise.all(Array.from({ length: 10 }, (_, i) => new JobWorker(queue, registry, { workerId: `w-${i}`, leaseMs: 30_000 }).runOnce()));
    assert.deepEqual(outcomes.filter((o) => o !== 'idle'), ['SUCCEEDED']);
    assert.equal(calls, 1);
    // 14
    await runScheduleTick(queue, [schedule], at(3_600_000));
    const stale = (await queue.claim('w-stale', 30_000))!;
    await h.owner.pool.query(`update platform_jobs set lease_expires_at = now() - interval '1 second' where job_id = $1`, [stale.jobId]);
    const fresh = (await queue.claim('w-fresh', 30_000))!;
    assert.equal(await queue.complete(stale.jobId, stale.leaseId), false);
    const row = (await h.owner.pool.query(`select status, lease_id from platform_jobs where job_id = $1`, [stale.jobId])).rows[0];
    assert.deepEqual([row.status, row.lease_id], ['RUNNING', fresh.leaseId]);
  });

  test('7/8: one organization failing does not stop the others; retries after a failed or crashed attempt never over-delete', async () => {
    for (const org of ['org-a', 'org-b', 'org-c']) await seedOrg(org, [-DAY, DAY]);
    const real = purgeRepo();
    let failB = true;
    let crashA = true;
    const flaky: RetentionPurgeRepository = {
      async purgeExpired(org, now) {
        if (org === 'org-b' && failB) throw new Error('transient');
        const n = await real.purgeExpired(org, now);
        if (org === 'org-a' && crashA) {
          crashA = false;
          throw new Error('crash after commit'); // effect committed, outcome not recorded
        }
        return n;
      },
    };
    const { queue, registry, schedule } = setup(flaky);
    await runScheduleTick(queue, [schedule], NOW);
    const outcomes = await drain(queue, registry);
    assert.deepEqual(outcomes.sort(), ['RETRY_WAIT', 'RETRY_WAIT', 'SUCCEEDED']);
    assert.deepEqual(await contentIds('org-c'), ['m-org-c-1'], '7: org C purged despite B failing');
    assert.deepEqual(await contentIds('org-b'), ['m-org-b-0', 'm-org-b-1'], '8: B`s failed attempt deleted nothing');
    assert.deepEqual(await contentIds('org-a'), ['m-org-a-1'], 'A`s committed effect happened once');
    failB = false;
    await h.owner.pool.query(`update platform_jobs set run_after = now() - interval '1 millisecond' where status = 'RETRY_WAIT'`);
    assert.deepEqual(await drain(queue, registry), ['SUCCEEDED', 'SUCCEEDED']);
    for (const org of ['org-a', 'org-b', 'org-c']) assert.deepEqual(await contentIds(org), [`m-${org}-1`], '8: retries purged exactly the eligible rows, never the future one');
  });

  test('17/15/16: a persistently failing purge goes DEAD after bounded attempts and is visible in stats; payloads, failure classes, events and stats never contain content', async () => {
    await seedOrg('org-a', [-DAY]);
    const failing: RetentionPurgeRepository = {
      async purgeExpired() {
        throw new Error(`${SENSITIVE} (simulated leak in an error message)`);
      },
    };
    const { queue, registry, schedule } = setup(failing);
    await runScheduleTick(queue, [schedule], NOW);
    const events: WorkerEvent[] = [];
    for (let i = 0; i < RETENTION_PURGE_MAX_ATTEMPTS; i += 1) {
      await drain(queue, registry, events);
      await h.owner.pool.query(`update platform_jobs set run_after = now() - interval '1 millisecond' where status = 'RETRY_WAIT'`);
    }
    const row = await job('org-a');
    assert.deepEqual([row.status, row.attempts, row.last_failure_class, row.payload], ['DEAD', RETENTION_PURGE_MAX_ATTEMPTS, 'retention_purge_failed', {}]);
    const [stats] = await queue.stats();
    assert.deepEqual([stats!.jobType, stats!.dead, stats!.deadFailureClasses], [RETENTION_PURGE_JOB_TYPE, 1, ['retention_purge_failed']]);
    const surfaces = JSON.stringify((await h.owner.pool.query(`select * from platform_jobs`)).rows) + JSON.stringify(events) + JSON.stringify(await queue.stats()) + inspect(events, { depth: 5 });
    for (const s of ['RAW-PATIENT-TEXT', 'chest pain', '+919999999999', 'simulated leak']) assert.ok(!surfaces.includes(s), `leaked ${s}`);
    assert.equal((await contentIds('org-a')).length, 1, 'the content is still there — and the next hourly job will retry it');
    // A DEAD run does not lose the obligation: the next period's job purges it once the cause is fixed.
    const { queue: q2, registry: r2, schedule: s2 } = setup();
    await runScheduleTick(q2, [s2], at(3_600_000));
    assert.deepEqual(await drain(q2, r2), ['SUCCEEDED']);
    assert.equal((await contentIds('org-a')).length, 0);
  });

  test('enumeration covers every organization that has ever had a channel (enabled or not), from the platform-global table, without reading content', async () => {
    await seedOrg('org-b', [-DAY], { channelEnabled: false });
    await seedOrg('org-a', [DAY]);
    assert.deepEqual(await channels().listOrganizationIdsWithChannels(), ['org-a', 'org-b']);
    await assert.rejects(h.app.pool.query(`delete from communication_channels`), (e: { code?: string }) => e.code === '42501', 'the runtime role cannot remove an organization from the enumeration source');
    await assert.rejects(h.app.pool.query(`update communication_channels set organization_id = 'x'`), (e: { code?: string }) => e.code === '42501');
  });
});
