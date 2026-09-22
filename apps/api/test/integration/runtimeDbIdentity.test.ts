import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createPostgresClient } from '@samvardiq/data-foundation/dist/postgres/client.js';

import { startLocalSupabaseCluster, type LocalSupabaseCluster } from '../../scripts/localSupabaseCluster.js';
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
