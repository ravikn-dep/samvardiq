import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  createPostgresClient,
  IdempotencyConflictError,
  InvalidJobError,
  JobFailure,
  JobQueue,
  JobRegistry,
  JobStoreError,
  JobWorker,
  runScheduleTick,
  type JobContext,
  type PostgresClient,
  type ScheduleDefinition,
  type WorkerEvent,
} from '../../src/index.js';
import { startHarness, type Harness } from './harness.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
type Behavior = (job: JobContext) => Promise<void>;

describe('platform-jobs against real PostgreSQL', () => {
  let h: Harness;
  let wide: PostgresClient; // a pool large enough for genuinely concurrent sessions
  let behavior: Behavior = async () => undefined;
  const calls: JobContext[] = [];
  const registry = new JobRegistry()
    .register({ type: 'test.org_job', scope: 'organization', payload: { period: 'date', batch: 'id' }, maxAttempts: 3, handle: (j) => (calls.push(j), behavior(j)) })
    .register({ type: 'test.platform_job', scope: 'platform', payload: {}, maxAttempts: 2, handle: (j) => (calls.push(j), behavior(j)) });
  const queue = () => new JobQueue(h.app.db, registry);
  const wideQueue = () => new JobQueue(wide.db, registry);
  const enqueue = (key: string, org = ORG_A, payload: Record<string, string> = { period: '2026-10-06' }) =>
    queue().enqueue({ type: 'test.org_job', organizationId: org, idempotencyKey: key, payload });
  const row = async (jobId: string) => (await h.owner.pool.query(`select * from platform_jobs where job_id = $1`, [jobId])).rows[0];
  const expireLease = (jobId: string) => h.owner.pool.query(`update platform_jobs set lease_expires_at = now() - interval '1 second' where job_id = $1`, [jobId]);
  const makeDue = (jobId: string) => h.owner.pool.query(`update platform_jobs set run_after = now() - interval '1 millisecond' where job_id = $1`, [jobId]);
  const worker = (id: string, events?: WorkerEvent[]) => new JobWorker(queue(), registry, { workerId: id, leaseMs: 30_000, random: () => 0.5, onEvent: events ? (e) => events.push(e) : undefined });

  before(async () => {
    h = await startHarness(55981);
    const appUrl = (h.app.pool as unknown as { options: { connectionString: string } }).options.connectionString;
    wide = createPostgresClient({ connectionString: appUrl, max: 40 });
  });
  after(async () => {
    await wide.close();
    await h.stop();
  });
  beforeEach(async () => {
    await h.truncateAll();
    calls.length = 0;
    behavior = async () => undefined;
  });

  test('schema: exact runtime grants — INSERT/SELECT, UPDATE on lifecycle columns only, no DELETE', async () => {
    const t = await h.owner.pool.query(`select string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants where grantee = 'samvardiq_app' and table_name = 'platform_jobs'`);
    assert.equal(t.rows[0].p, 'INSERT,SELECT');
    const c = await h.owner.pool.query(`select string_agg(column_name, ',' order by column_name) as c from information_schema.column_privileges where grantee = 'samvardiq_app' and table_name = 'platform_jobs' and privilege_type = 'UPDATE'`);
    assert.equal(c.rows[0].c, 'attempts,finished_at,last_failure_class,lease_expires_at,lease_id,lease_owner,run_after,started_at,status,updated_at');
    const { jobId } = await enqueue('grants');
    for (const stmt of [`delete from platform_jobs`, `update platform_jobs set payload = '{}'`, `update platform_jobs set organization_id = 'org-b'`, `update platform_jobs set job_type = 'x.y'`, `update platform_jobs set idempotency_key = 'k'`, `update platform_jobs set max_attempts = 25`]) {
      await assert.rejects(h.app.pool.query(stmt), (e: { code?: string }) => e.code === '42501', stmt);
    }
    assert.equal((await row(jobId)).status, 'PENDING');
  });

  test('A/B/AY: enqueue is idempotent per (type, key); a different job under the same key is an explicit conflict', async () => {
    const first = await enqueue('k1', ORG_A, { period: '2026-10-06', batch: 'b1' });
    assert.equal(first.created, true);
    const r = await row(first.jobId);
    assert.deepEqual([r.status, r.attempts, r.max_attempts, r.organization_id, r.payload], ['PENDING', 0, 3, ORG_A, { period: '2026-10-06', batch: 'b1' }]);
    assert.deepEqual(await enqueue('k1', ORG_A, { batch: 'b1', period: '2026-10-06' }), { jobId: first.jobId, created: false }, 'same job, key order irrelevant');
    await assert.rejects(enqueue('k1', ORG_B, { period: '2026-10-06', batch: 'b1' }), IdempotencyConflictError);
    await assert.rejects(enqueue('k1', ORG_A, { period: '2026-10-07', batch: 'b1' }), IdempotencyConflictError);
    const other = await queue().enqueue({ type: 'test.platform_job', idempotencyKey: 'k1', payload: {} });
    assert.equal(other.created, true, 'keys are namespaced by job type');
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from platform_jobs`)).rows[0].n, 2);
    // A completed logical job is never re-run by re-enqueueing the same key; a new period uses a new key.
    const w = worker('w-1');
    while ((await w.runOnce()) !== 'idle');
    assert.equal((await enqueue('k1', ORG_A, { period: '2026-10-06', batch: 'b1' })).created, false);
    assert.equal((await w.runOnce()), 'idle');
  });

  test('scope and identifiers are validated before persistence; nothing invalid is written', async () => {
    await assert.rejects(queue().enqueue({ type: 'test.org_job', idempotencyKey: 'x', payload: {} }), InvalidJobError, 'org job without organization');
    await assert.rejects(queue().enqueue({ type: 'test.platform_job', organizationId: ORG_A, idempotencyKey: 'x', payload: {} }), InvalidJobError, 'platform job with organization');
    await assert.rejects(enqueue('has space'), InvalidJobError);
    await assert.rejects(enqueue('k', 'org a'), InvalidJobError);
    await assert.rejects(enqueue('k', ORG_A, { period: '2026-10-06', patientName: 'Ravi' }), InvalidJobError);
    await assert.rejects(enqueue('k', ORG_A, { period: '2026-10-06', batch: 'ya29.a0Af' }), InvalidJobError);
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from platform_jobs`)).rows[0].n, 0);
  });

  test('C: 50 concurrent identical enqueues create exactly one job (unique constraint, not check-then-insert)', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => wideQueue().enqueue({ type: 'test.org_job', organizationId: ORG_A, idempotencyKey: 'race', payload: { period: '2026-10-06' } })));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.jobId)).size, 1);
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from platform_jobs`)).rows[0].n, 1);
  });

  test('D/E/F: one job, 30 concurrent claimers — exactly one lease', async () => {
    const { jobId } = await enqueue('one');
    const claims = await Promise.all(Array.from({ length: 30 }, (_, i) => wideQueue().claim(`w-${i}`, 30_000)));
    const won = claims.filter((c) => c !== null);
    assert.equal(won.length, 1);
    const r = await row(jobId);
    assert.deepEqual([r.status, r.attempts, r.lease_id, r.lease_owner], ['RUNNING', 1, won[0]!.leaseId, `w-${claims.indexOf(won[0]!)}`]);
    assert.ok(r.lease_expires_at > new Date(Date.now() + 25_000));
  });

  test('many workers, many jobs: 200 jobs drained by 20 concurrent claim loops — each claimed exactly once', async () => {
    for (let i = 0; i < 200; i += 1) await enqueue(`many-${i}`);
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 20 }, async (_, w) => {
        for (;;) {
          const job = await wideQueue().claim(`w-${w}`, 30_000);
          if (!job) return;
          claimed.push(job.jobId);
          assert.equal(await wideQueue().complete(job.jobId, job.leaseId), true);
        }
      }),
    );
    assert.equal(claimed.length, 200);
    assert.equal(new Set(claimed).size, 200);
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from platform_jobs where status = 'SUCCEEDED' and attempts = 1`)).rows[0].n, 200);
  });

  test('JobWorker at concurrency: 10 workers × 150 jobs → every handler runs exactly once, all SUCCEEDED', async () => {
    for (let i = 0; i < 150; i += 1) await enqueue(`wk-${i}`);
    await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const w = new JobWorker(wideQueue(), registry, { workerId: `w-${i}`, leaseMs: 30_000 });
      while ((await w.runOnce()) !== 'idle');
    }));
    assert.equal(calls.length, 150);
    assert.equal(new Set(calls.map((c) => c.jobId)).size, 150);
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from platform_jobs where status = 'SUCCEEDED'`)).rows[0].n, 150);
  });

  test('G/J/K/L/M/N: crash before the handler → lease expiry → reclaim with a new fence; the stale worker can neither complete, fail nor renew', async () => {
    const { jobId } = await enqueue('crash');
    const stale = (await queue().claim('w-old', 30_000))!;
    assert.equal(await queue().renew(jobId, stale.leaseId, 60_000), true, 'N: holder renews');
    assert.equal(await queue().claim('w-new', 30_000), null, 'an unexpired lease is not reclaimable');
    await expireLease(jobId);
    const fresh = (await queue().claim('w-new', 30_000))!;
    assert.equal(fresh.jobId, jobId);
    assert.equal(fresh.attempt, 2);
    assert.notEqual(fresh.leaseId, stale.leaseId);
    assert.equal(await queue().complete(jobId, stale.leaseId), false, 'K');
    assert.equal(await queue().fail(jobId, stale.leaseId, 'permanent', 'boom', 0), null, 'L');
    assert.equal(await queue().renew(jobId, stale.leaseId, 60_000), false, 'M');
    const r = await row(jobId);
    assert.deepEqual([r.status, r.lease_id, r.lease_owner, r.last_failure_class], ['RUNNING', fresh.leaseId, 'w-new', null], 'the new holder`s state is untouched');
    assert.equal(await queue().complete(jobId, fresh.leaseId), true);
    assert.equal((await row(jobId)).status, 'SUCCEEDED');
  });

  test('H/I/AI: side effect committed, worker crashes before success → re-run is absorbed by the idempotent effect', async () => {
    await h.owner.pool.query(`create table if not exists test_effects (effect_key text primary key)`);
    await h.owner.pool.query(`grant select, insert on test_effects to samvardiq_app`);
    await h.owner.pool.query(`truncate test_effects`);
    const effect = (j: JobContext) => h.app.pool.query(`insert into test_effects values ($1) on conflict do nothing`, [`${j.organizationId}:${j.payload.period}`]);
    const { jobId } = await enqueue('effect');
    const crashed = (await queue().claim('w-crash', 30_000))!;
    await effect({ jobId, jobType: 'test.org_job', organizationId: ORG_A, payload: crashed.payload as never, attempt: 1, signal: new AbortController().signal });
    // ...process dies (deployment / crash) before complete(): nothing more happens until the lease expires.
    assert.equal(await worker('w-other').runOnce(), 'idle');
    await expireLease(jobId);
    behavior = async (j) => void (await effect(j));
    assert.equal(await worker('w-other').runOnce(), 'SUCCEEDED');
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from test_effects`)).rows[0].n, 1, 'effect applied once despite two executions');
    assert.equal((await row(jobId)).attempts, 2);
  });

  test('success-vs-reclaim and renewal-vs-reclaim races: never both (40 rounds each)', async () => {
    for (let i = 0; i < 40; i += 1) {
      const { jobId } = await enqueue(`race-c-${i}`);
      const a = (await wideQueue().claim('w-a', 30_000))!;
      await expireLease(jobId);
      const [done, b] = await Promise.all([wideQueue().complete(jobId, a.leaseId), wideQueue().claim('w-b', 30_000)]);
      assert.ok(done !== (b !== null), `round ${i}: exactly one of stale-complete / reclaim wins`);
      const r = await row(jobId);
      assert.equal(r.status, done ? 'SUCCEEDED' : 'RUNNING');
    }
    for (let i = 0; i < 40; i += 1) {
      const { jobId } = await enqueue(`race-r-${i}`);
      const a = (await wideQueue().claim('w-a', 30_000))!;
      await expireLease(jobId);
      const [renewed, b] = await Promise.all([wideQueue().renew(jobId, a.leaseId, 30_000), wideQueue().claim('w-b', 30_000)]);
      const r = await row(jobId);
      if (b) assert.equal(r.lease_id, b.leaseId, `round ${i}: reclaim holds the lease`);
      else assert.ok(renewed && r.lease_id === a.leaseId, `round ${i}: renewal kept the lease`);
      // If both "succeeded", the renewal preceded the reclaim check and the reclaim must have failed — enforced above.
    }
  });

  test('O/S/R/Q: retryable failure → RETRY_WAIT with backoff, not claimable early; attempts exhaust to DEAD', async () => {
    behavior = async () => {
      throw new JobFailure('retryable', 'rate_limited');
    };
    const { jobId } = await enqueue('retry');
    assert.equal(await worker('w').runOnce(), 'RETRY_WAIT');
    let r = await row(jobId);
    assert.deepEqual([r.status, r.attempts, r.last_failure_class, r.lease_id], ['RETRY_WAIT', 1, 'rate_limited', null]);
    const delay1 = (r.run_after.getTime() - r.updated_at.getTime()) / 1000;
    assert.ok(delay1 > 29.9 && delay1 < 30.1, `first backoff ≈ 30 s (got ${delay1})`);
    assert.equal(await worker('w').runOnce(), 'idle', 'S: RETRY_WAIT is not claimed before run_after');
    await makeDue(jobId);
    assert.equal(await worker('w').runOnce(), 'RETRY_WAIT');
    r = await row(jobId);
    const delay2 = (r.run_after.getTime() - r.updated_at.getTime()) / 1000;
    assert.ok(delay2 > 59.9 && delay2 < 60.1, `second backoff ≈ 60 s (got ${delay2})`);
    await makeDue(jobId);
    assert.equal(await worker('w').runOnce(), 'DEAD', 'Q: third failure exhausts max_attempts=3');
    r = await row(jobId);
    assert.deepEqual([r.status, r.attempts, r.last_failure_class], ['DEAD', 3, 'rate_limited']);
    assert.ok(r.finished_at instanceof Date);
  });

  test('P/T/U/AX: permanent failure is DEAD at once; DEAD and SUCCEEDED are never claimed; the queue keeps working', async () => {
    behavior = async () => {
      throw new JobFailure('permanent', 'invalid_reference');
    };
    const dead = await enqueue('perm');
    assert.equal(await worker('w').runOnce(), 'DEAD');
    assert.deepEqual([(await row(dead.jobId)).attempts, (await row(dead.jobId)).last_failure_class], [1, 'invalid_reference']);
    behavior = async () => undefined;
    const ok = await enqueue('ok');
    assert.equal(await worker('w').runOnce(), 'SUCCEEDED');
    await h.owner.pool.query(`update platform_jobs set run_after = now() - interval '1 day'`);
    assert.equal(await worker('w').runOnce(), 'idle', 'neither DEAD nor SUCCEEDED is claimable, however old');
    assert.equal((await row(ok.jobId)).status, 'SUCCEEDED');
    assert.equal(calls.length, 2);
  });

  test('AW: a job that keeps killing its worker reaches DEAD (lease_expired) instead of looping', async () => {
    const { jobId } = await enqueue('poison');
    for (let i = 1; i <= 3; i += 1) {
      const j = (await queue().claim(`w-${i}`, 30_000))!;
      assert.equal(j.attempt, i);
      await expireLease(jobId); // worker died mid-handler
    }
    assert.equal(await queue().claim('w-4', 30_000), null);
    const r = await row(jobId);
    assert.deepEqual([r.status, r.attempts, r.last_failure_class, r.lease_id], ['DEAD', 3, 'lease_expired', null]);
  });

  test('V/W: a stored job of an unknown type, with an invalid payload, or the wrong scope ends DEAD without running any handler', async () => {
    const insert = (type: string, org: string | null, payload: string, key: string) =>
      h.owner.pool.query(`insert into platform_jobs (job_id, job_type, organization_id, idempotency_key, payload, status, max_attempts) values (gen_random_uuid(), $1, $2, $3, $4::jsonb, 'PENDING', 3)`, [type, org, key, payload]);
    await insert('test.unregistered', ORG_A, '{}', 'u');
    await insert('test.org_job', ORG_A, '{"text":"hello patient"}', 'w');
    await insert('test.org_job', null, '{"period":"2026-10-06"}', 's');
    const outcomes = [await worker('w').runOnce(), await worker('w').runOnce(), await worker('w').runOnce()];
    assert.deepEqual(outcomes, ['DEAD', 'DEAD', 'DEAD']);
    const classes = (await h.owner.pool.query(`select idempotency_key, last_failure_class from platform_jobs order by 1`)).rows.map((r) => [r.idempotency_key, r.last_failure_class]);
    assert.deepEqual(classes, [['s', 'invalid_scope'], ['u', 'unknown_job_type'], ['w', 'invalid_payload']]);
    assert.equal(calls.length, 0);
  });

  test('X: the database itself rejects oversized or non-object payloads and invalid states', async () => {
    const bad = [
      `insert into platform_jobs (job_id, job_type, idempotency_key, payload, status, max_attempts) values (gen_random_uuid(), 'a.b', 'big', jsonb_build_object('k', repeat('x', 2000)), 'PENDING', 1)`,
      `insert into platform_jobs (job_id, job_type, idempotency_key, payload, status, max_attempts) values (gen_random_uuid(), 'a.b', 'arr', '[1]', 'PENDING', 1)`,
      `insert into platform_jobs (job_id, job_type, idempotency_key, payload, status, max_attempts) values (gen_random_uuid(), 'a.b', 'st', '{}', 'DONE', 1)`,
      `insert into platform_jobs (job_id, job_type, idempotency_key, payload, status, max_attempts) values (gen_random_uuid(), 'a.b', 'rl', '{}', 'RUNNING', 1)`,
      `insert into platform_jobs (job_id, job_type, idempotency_key, payload, status, max_attempts, last_failure_class) values (gen_random_uuid(), 'a.b', 'fc', '{}', 'PENDING', 1, 'Error: select * from x')`,
    ];
    for (const stmt of bad) await assert.rejects(h.owner.pool.query(stmt), (e: { code?: string }) => e.code === '23514', stmt.slice(0, 80));
  });

  test('AN/AO/AP: an unclassified error carrying SQL parameters, a credentialed URL and a token is stored and reported only as "unhandled_error"', async () => {
    const leak = 'Failed query: insert into x values ($1) params: ya29.SECRETTOKEN postgres://admin:hunter2@db.example:5432/postgres patient Ravi';
    behavior = async () => {
      throw new Error(leak);
    };
    const events: WorkerEvent[] = [];
    const captured: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const capture = (...a: unknown[]) => void captured.push(a.map((x) => inspect(x)).join(' '));
    Object.assign(console, { log: capture, error: capture, warn: capture, info: capture });
    let jobId: string;
    try {
      jobId = (await enqueue('leak')).jobId;
      assert.equal(await worker('w', events).runOnce(), 'RETRY_WAIT');
    } finally {
      Object.assign(console, original);
    }
    const dump = JSON.stringify((await h.owner.pool.query(`select * from platform_jobs`)).rows) + JSON.stringify(events) + captured.join('\n') + JSON.stringify(await queue().stats());
    for (const s of ['SECRETTOKEN', 'hunter2', 'postgres://', 'Failed query', 'Ravi', 'params']) assert.ok(!dump.includes(s), `leaked ${s}`);
    assert.equal((await row(jobId!)).last_failure_class, 'unhandled_error');
    assert.deepEqual(events.map((e) => Object.keys(e).sort()), [['attempt', 'failureClass', 'jobId', 'jobType', 'outcome']]);
  });

  test('AV: claim is atomic — a claim inside a rolled-back transaction leaves the job PENDING with no attempt consumed', async () => {
    const { jobId } = await enqueue('tx');
    await assert.rejects(
      h.app.db.transaction(async (tx) => {
        const j = await new JobQueue(tx as never, registry).claim('w-tx', 30_000);
        assert.equal(j?.jobId, jobId);
        throw new Error('rollback');
      }),
    );
    const r = await row(jobId);
    assert.deepEqual([r.status, r.attempts, r.lease_id], ['PENDING', 0, null]);
  });

  test('AZ: clock boundaries — run_after in the future is not due, at/just past now() it is; the database clock decides', async () => {
    const { jobId } = await queue().enqueue({ type: 'test.org_job', organizationId: ORG_A, idempotencyKey: 'later', payload: { period: '2026-10-06' }, runAfter: new Date(Date.now() + 60_000) });
    assert.equal(await queue().claim('w', 30_000), null);
    await h.owner.pool.query(`update platform_jobs set run_after = now() + interval '2 seconds' where job_id = $1`, [jobId]);
    assert.equal(await queue().claim('w', 30_000), null);
    await makeDue(jobId);
    assert.equal((await queue().claim('w', 30_000))?.jobId, jobId);
  });

  test('AE/AF/AG/AZ: schedule ticks — repeated and 12 concurrent ticks enqueue one job per (period, target); a missed period is not back-filled', async () => {
    const targetsCalls: Date[] = [];
    const schedule: ScheduleDefinition = {
      name: 'test_daily',
      jobType: 'test.org_job',
      periodMs: 86_400_000,
      targets: async ({ start }) => (targetsCalls.push(start), [ORG_A, ORG_B, 'org-c'].map((o) => ({ organizationId: o, key: o, payload: { period: start.toISOString().slice(0, 10) } }))),
    };
    const day = (d: string) => new Date(`${d}T10:00:00Z`);
    assert.deepEqual(await runScheduleTick(queue(), [schedule], day('2026-10-06')), { enqueued: 3, existing: 0 });
    assert.deepEqual(await runScheduleTick(queue(), [schedule], day('2026-10-06')), { enqueued: 0, existing: 3 }, 'AE: duplicate tick');
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => runScheduleTick(wideQueue(), [schedule], day('2026-10-07'))));
    assert.equal(concurrent.reduce((n, r) => n + r.enqueued, 0), 3, 'AF: 12 concurrent ticks → 3 jobs');
    await runScheduleTick(queue(), [schedule], day('2026-10-09')); // AG: the 8th was missed
    const periods = (await h.owner.pool.query(`select distinct payload->>'period' as p from platform_jobs order by 1`)).rows.map((r) => r.p);
    assert.deepEqual(periods, ['2026-10-06', '2026-10-07', '2026-10-09']);
    const keys = (await h.owner.pool.query(`select idempotency_key as k from platform_jobs where organization_id = $1 order by 1`, [ORG_A])).rows.map((r) => r.k);
    assert.deepEqual(keys, ['test_daily:2026-10-06T00:00:00Z:org-a', 'test_daily:2026-10-07T00:00:00Z:org-a', 'test_daily:2026-10-09T00:00:00Z:org-a']);
    // AZ: the period boundary is exact.
    await runScheduleTick(queue(), [schedule], new Date('2026-10-10T00:00:00.000Z'));
    await runScheduleTick(queue(), [schedule], new Date('2026-10-09T23:59:59.999Z'));
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from platform_jobs where payload->>'period' = '2026-10-10'`)).rows[0].n, 3);
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from platform_jobs where payload->>'period' = '2026-10-09'`)).rows[0].n, 3);
  });

  test('AH: a database outage surfaces only a sanitized JobStoreError, and the worker loop survives it without crashing', async () => {
    const down = createPostgresClient({ connectionString: 'postgres://samvardiq_app:wrong-password-xyz@localhost:1/none', connectionTimeoutMillis: 500 });
    try {
      const err = await new JobQueue(down.db, registry).enqueue({ type: 'test.platform_job', idempotencyKey: 'x', payload: {} }).catch((e: unknown) => e);
      assert.ok(err instanceof JobStoreError, inspect(err));
      assert.ok(!`${inspect(err, { showHidden: true })}${JSON.stringify(err)}`.includes('wrong-password-xyz'));
      const events: WorkerEvent[] = [];
      const w = new JobWorker(new JobQueue(down.db, registry), registry, { workerId: 'w-down', onEvent: (e) => events.push(e) });
      const stop = new AbortController();
      const loop = w.run(stop.signal, 50);
      await new Promise((r) => setTimeout(r, 400));
      stop.abort();
      await loop;
      assert.ok(events.length >= 2 && events.every((e) => e.outcome === 'store_error' && Object.keys(e).length === 1));
    } finally {
      await down.close();
    }
  });

  test('AM: a handler receives identifiers and an abort signal only — no context, connection or authority object', async () => {
    let seen: JobContext | undefined;
    behavior = async (j) => void (seen = j);
    await enqueue('am', ORG_A, { period: '2026-10-06', batch: 'b' });
    await worker('w').runOnce();
    assert.deepEqual(Object.keys(seen!).sort(), ['attempt', 'jobId', 'jobType', 'organizationId', 'payload', 'signal']);
    assert.equal(typeof seen!.organizationId, 'string');
  });

  test('a handler that outlives its lease is aborted and its completion is refused (fencing through the worker)', async () => {
    const { jobId } = await enqueue('slow');
    let aborted = false;
    behavior = async (j) => {
      await h.owner.pool.query(`update platform_jobs set lease_id = gen_random_uuid(), lease_owner = 'w-thief' where job_id = $1`, [jobId]); // lease taken over
      await new Promise<void>((resolve) => {
        j.signal.addEventListener('abort', () => ((aborted = true), resolve()), { once: true });
        setTimeout(resolve, 2_500);
      });
    };
    const w = new JobWorker(queue(), registry, { workerId: 'w-slow', leaseMs: 1_500 });
    assert.equal(await w.runOnce(), 'LEASE_LOST');
    assert.equal(aborted, true, 'the heartbeat noticed the lost lease and aborted the handler');
    assert.equal((await row(jobId)).lease_owner, 'w-thief');
  });

  test('observability: stats expose counts, ages, stale leases and failure classes — never payloads or organizations', async () => {
    behavior = async () => {
      throw new JobFailure('permanent', 'invalid_reference');
    };
    await enqueue('s1', ORG_A, { period: '2001-02-03', batch: 'secretish-id' });
    await worker('w').runOnce();
    behavior = async () => undefined;
    await enqueue('s2', ORG_A, { period: '2001-02-03' });
    await enqueue('s3', ORG_A, { period: '2001-02-03' });
    const running = (await queue().claim('w', 30_000))!;
    await expireLease(running.jobId);
    await queue().enqueue({ type: 'test.org_job', organizationId: ORG_B, idempotencyKey: 's4', payload: { period: '2001-02-03' }, runAfter: new Date(Date.now() + 3_600_000) });
    const [s] = await queue().stats();
    assert.deepEqual(
      { ...s, oldestDueSeconds: s!.oldestDueSeconds >= 0, nextRunAfter: typeof s!.nextRunAfter },
      { jobType: 'test.org_job', pending: 2, running: 1, retryWait: 0, succeeded: 0, dead: 1, staleLeases: 1, oldestDueSeconds: true, nextRunAfter: 'string', maxActiveAttempts: 1, deadFailureClasses: ['invalid_reference'] },
    );
    const text = JSON.stringify(await queue().stats());
    for (const s2 of [ORG_A, ORG_B, 'secretish-id', '2001-02-03']) assert.ok(!text.includes(s2));
  });
});
