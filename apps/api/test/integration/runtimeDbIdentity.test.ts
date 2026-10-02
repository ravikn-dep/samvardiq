import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createPostgresClient } from '@samvardiq/data-foundation/dist/postgres/client.js';
import { goals, withOrganizationContext } from '@samvardiq/data-foundation/dist/postgres/index.js';

import { startLocalSupabaseCluster, type LocalSupabaseCluster } from '../../scripts/localSupabaseCluster.js';
import { loadConfigFromEnv, runtimePoolConfig } from '../../src/config.js';
import { assertRuntimeRole, RuntimeDatabaseIdentityError } from '../../src/runtimeDbIdentity.js';

/**
 * INFRA-W1D — real-PostgreSQL adversarial proof for the deployed API's own
 * database identity: privilege escalation (Step 15), pooled-connection RLS
 * context leakage through apps/api's actual connection pattern (Step 16),
 * and migration/runtime credential separation (Step 17). Every claim here
 * that depends on PostgreSQL's own enforcement runs against a real,
 * disposable, Supabase-shaped cluster — never mocked.
 */

let cluster: LocalSupabaseCluster;

before(async () => {
  cluster = await startLocalSupabaseCluster(55961, { migrate: true, harden: true });
}, { timeout: 120_000 });

after(async () => {
  await cluster.stop();
});

test('assertRuntimeRole REJECTS the owner/migration connection (proves a misrouted admin credential is caught)', async () => {
  await assert.rejects(assertRuntimeRole(cluster.owner.pool), (error: unknown) => error instanceof RuntimeDatabaseIdentityError && /Connected as "postgres"/.test((error as Error).message));
});

test('assertRuntimeRole ACCEPTS the real samvardiq_app connection', async () => {
  const app = createPostgresClient({ connectionString: cluster.appUrl });
  try {
    const attrs = await assertRuntimeRole(app.pool);
    assert.equal(attrs.currentUser, 'samvardiq_app');
    assert.deepEqual(
      { super: attrs.rolsuper, bypassrls: attrs.rolbypassrls, createdb: attrs.rolcreatedb, createrole: attrs.rolcreaterole, replication: attrs.rolreplication },
      { super: false, bypassrls: false, createdb: false, createrole: false, replication: false },
    );
  } finally {
    await app.close();
  }
});

test('privilege escalation matrix: samvardiq_app cannot CREATE DATABASE/ROLE, ALTER itself, SET ROLE to the owner, disable/alter RLS, DDL, DROP, or mutate immutable audit rows', async () => {
  const app = createPostgresClient({ connectionString: cluster.appUrl });
  const forbidden: [string, string][] = [
    ['CREATE DATABASE escalation_probe', 'create database'],
    ['CREATE ROLE escalation_probe', 'create role'],
    ['ALTER ROLE samvardiq_app SUPERUSER', 'grant itself superuser'],
    ['ALTER ROLE samvardiq_app CREATEROLE', 'grant itself createrole'],
    ['SET ROLE postgres', 'assume the owner role'],
    ['ALTER TABLE goals DISABLE ROW LEVEL SECURITY', 'disable RLS'],
    ['ALTER TABLE goals ADD COLUMN escalation_probe text', 'alter a protected table (DDL)'],
    ['DROP TABLE goals', 'drop a protected table'],
    ["UPDATE approval_records SET decision = 'REJECTED'", 'mutate an immutable audit table'],
  ];
  try {
    for (const [statement, label] of forbidden) {
      await assert.rejects(app.pool.query(statement), (error: { code?: string }) => typeof error.code === 'string', `${label} must be rejected by PostgreSQL, not merely by application code`);
    }
  } finally {
    await app.close();
  }
});

test('expected runtime operations continue to work after the lockdown is confirmed (the matrix above is not overbroad)', async () => {
  const app = createPostgresClient({ connectionString: cluster.appUrl });
  try {
    await app.pool.query(`select set_config('app.current_org_id', 'w1d-org', true)`);
  } finally {
    // set_config with is_local=true outside an explicit transaction has no lasting effect to clean up; nothing further needed.
    await app.close();
  }
});

test('migration/runtime separation: the runtime credential cannot perform a migration-shaped DDL operation (CREATE TABLE)', async () => {
  const app = createPostgresClient({ connectionString: cluster.appUrl });
  try {
    await assert.rejects(app.pool.query('create table public.w1d_migration_probe (id text primary key)'), (error: { code?: string }) => typeof error.code === 'string');
  } finally {
    await app.close();
  }
});

test('pool-context leakage through apps/api’s own connection pattern: org A, then org B, then missing context, reusing the SAME pool object end to end', async () => {
  const app = createPostgresClient({ connectionString: cluster.appUrl });
  try {
    // Seed via the owner (bypasses RLS) so this test needs no app-role write path of its own.
    await cluster.owner.pool.query(`insert into organizations (organization_id, organization_type, name, status) values ('w1d-org-a', 'clinic', 'A', 'active'), ('w1d-org-b', 'clinic', 'B', 'active')`);
    await cluster.owner.pool.query(`insert into goals (organization_id, goal_id, title, description, status) values ('w1d-org-a', 'w1d-goal-a', 'x', 'y', 'active'), ('w1d-org-b', 'w1d-goal-b', 'x', 'y', 'active')`);

    // Same shape as withOrganizationContext (packages/*/src/postgres/client.ts): checkout a pool
    // connection, set_config(..., true) [SET LOCAL semantics] inside one transaction, query, then
    // release the connection back to the pool for the NEXT call to reuse.
    async function readAs(organizationId: string | undefined): Promise<string[]> {
      const client = await app.pool.connect();
      try {
        await client.query('BEGIN');
        if (organizationId !== undefined) await client.query(`select set_config('app.current_org_id', $1, true)`, [organizationId]);
        const { rows } = await client.query('select organization_id from goals');
        await client.query('COMMIT');
        return (rows as { organization_id: string }[]).map((r) => r.organization_id);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    assert.deepEqual(await readAs('w1d-org-a'), ['w1d-org-a'], 'org A sees only its own row');
    assert.deepEqual(await readAs('w1d-org-b'), ['w1d-org-b'], 'immediately afterward, on the SAME pool, org B sees only its own row — org A never leaked forward');
    assert.deepEqual(await readAs(undefined), [], 'a request with no context on the SAME pool sees nothing — no prior organization`s context survived');
    assert.deepEqual(await readAs('w1d-org-a'), ['w1d-org-a'], 'org A again, after a no-context request — still correct');

    // A transaction that throws mid-way must not leave app.current_org_id set for whichever connection returns to the pool next.
    const failing = await app.pool.connect();
    try {
      await failing.query('BEGIN');
      await failing.query(`select set_config('app.current_org_id', 'w1d-org-b', true)`);
      await assert.rejects(failing.query('select 1/0')); // deliberate runtime error inside the transaction
      await failing.query('ROLLBACK');
    } finally {
      failing.release();
    }
    assert.deepEqual(await readAs(undefined), [], 'after an aborted transaction, a fresh no-context request still sees nothing');

    // Concurrent organizations on the SAME pool, high-concurrency reuse.
    const expected = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 'w1d-org-a' : 'w1d-org-b'));
    const results = await Promise.all(expected.map((organizationId) => readAs(organizationId)));
    assert.deepEqual(results, expected.map((organizationId) => [organizationId]), 'concurrent org A/B reads never cross-contaminate under pool reuse');
  } finally {
    await app.close();
  }
});

/**
 * INFRA-W1D-POOL-F1 — the same proof under the bounded runtime budget (DATABASE_POOL_MAX=3, the staging value):
 * contention far above `max` must queue inside pg (never open a 4th session), keep RLS context per transaction,
 * release clients on every failure path, time out instead of hanging when exhausted, and close cleanly.
 */
test('bounded runtime pool (DATABASE_POOL_MAX=3): isolation under contention, queueing, failure release, exhaustion timeout, shutdown', async () => {
  const poolConfig = runtimePoolConfig(loadConfigFromEnv({ DATABASE_POOL_MAX: '3' } as unknown as NodeJS.ProcessEnv));
  const app = createPostgresClient({ connectionString: cluster.appUrl, ...poolConfig });
  const A = 'w1d-pool-a';
  const B = 'w1d-pool-b';
  await cluster.owner.pool.query(`insert into organizations (organization_id, organization_type, name, status) values ($1, 'clinic', 'A', 'active'), ($2, 'clinic', 'B', 'active')`, [A, B]);
  await cluster.owner.pool.query(`insert into goals (organization_id, goal_id, title, description, status) values ($1, 'pool-goal-a', 'x', 'y', 'active'), ($2, 'pool-goal-b', 'x', 'y', 'active')`, [A, B]);

  let peak = 0;
  app.pool.on('acquire', () => {
    peak = Math.max(peak, app.pool.totalCount);
  });
  // The real per-package context function; "none" is a plain query with no context, as an unscoped request would issue.
  const read = async (org: string | undefined): Promise<string[]> => {
    const rows = org === undefined
      ? await app.db.select({ o: goals.organizationId }).from(goals)
      : await withOrganizationContext(app.db, org, (tx) => tx.select({ o: goals.organizationId }).from(goals));
    return rows.map((r) => r.o).sort();
  };
  const settled = () => assert.deepEqual({ waiting: app.pool.waitingCount, idle: app.pool.idleCount }, { waiting: 0, idle: app.pool.totalCount }, 'every client returned to the pool');

  try {
    assert.deepEqual(await read(A), [A]);
    assert.deepEqual(await read(B), [B]);
    assert.deepEqual(await read(undefined), []);
    assert.deepEqual(await read(A), [A]);
    await assert.rejects(withOrganizationContext(app.db, B, async (tx) => {
      await tx.select().from(goals);
      throw new Error('application error mid-transaction');
    }));
    assert.deepEqual(await read(undefined), [], 'no context survives a thrown, rolled-back transaction');
    assert.deepEqual(await read(A), [A]);

    // Query failures release their client: a cross-org INSERT is an RLS violation (42501), 10x on a 3-connection pool.
    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(
        withOrganizationContext(app.db, A, (tx) => tx.insert(goals).values({ organizationId: B, goalId: `cross-${i}`, title: 'x', description: 'y', status: 'active' })),
        (error: { cause?: { code?: string } }) => error.cause?.code === '42501',
      );
    }
    settled();

    // Contention: 60 concurrent A/B/none operations on max=3 — queued by pg, never a 4th session, never cross-tenant.
    const plan = Array.from({ length: 60 }, (_, i) => [A, B, undefined][i % 3]);
    const results = await Promise.all(plan.map((org) => read(org)));
    assert.deepEqual(results, plan.map((org) => (org === undefined ? [] : [org])));
    assert.ok(peak <= 3, `pool opened ${peak} sessions with max=3`);
    const server = await cluster.owner.pool.query(`select count(*)::int as n from pg_stat_activity where usename = 'samvardiq_app'`);
    assert.ok(server.rows[0].n <= 3, `server sees ${server.rows[0].n} samvardiq_app sessions`);
    settled();
  } finally {
    await app.close();
  }
  assert.equal(app.pool.totalCount, 0, 'close() ends every session');
  await assert.rejects(app.pool.query('select 1'), 'a closed pool refuses new work');

  // Exhaustion: with every client checked out, a waiter fails with pg's timeout (here shortened from 10 s) — no URL or
  // password in the error — and the pool recovers as soon as one client is released.
  const tight = createPostgresClient({ connectionString: cluster.appUrl, ...poolConfig, connectionTimeoutMillis: 300 });
  const held = await Promise.all([1, 2, 3].map(() => tight.pool.connect()));
  try {
    const error = await tight.pool.connect().then(() => undefined, (e: Error) => e);
    assert.ok(error, 'a 4th checkout must not succeed while 3 are held');
    assert.match(error.message, /timeout/i);
    assert.ok(!error.message.includes(cluster.appUrl) && !error.message.includes(new URL(cluster.appUrl).password));
    assert.equal(tight.pool.totalCount, 3);
    held.pop()!.release();
    assert.equal((await tight.pool.query('select 1 as one')).rows[0].one, 1, 'recovers after a release');
  } finally {
    held.forEach((client) => client.release());
    await tight.close();
  }
  await cluster.owner.pool.query(`delete from goals where organization_id in ($1, $2)`, [A, B]);
  await cluster.owner.pool.query(`delete from organizations where organization_id in ($1, $2)`, [A, B]);
});
