import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createPostgresClient, type PostgresClient } from '@samvardiq/data-foundation/dist/postgres/client.js';

import { startLocalSupabaseCluster, type LocalSupabaseCluster } from '../../scripts/localSupabaseCluster.js';
import { PLATFORM_GLOBAL_POLICY, PLATFORM_GLOBAL_TABLES, applySupabaseHardening } from '../../scripts/supabaseHardening.js';

/**
 * INFRA-W1B regression coverage for the two Supabase-platform defects (F1/F2)
 * found against the real `samvardiq-staging` project: local, vanilla-Postgres
 * proofs could never have shown them. This rehearses the exact platform
 * behaviour in a disposable cluster — `anon`/`authenticated`/`service_role`,
 * Supabase's default ACLs, and Supabase's real `rls_auto_enable` event
 * trigger (copied from the staging project) — then proves the hardening step
 * repairs it. Disposable cluster only; never a real project.
 */

let cluster: LocalSupabaseCluster;
let owner: PostgresClient;
let app: PostgresClient;

before(async () => {
  cluster = await startLocalSupabaseCluster(55931, { migrate: true, harden: false });
  owner = cluster.owner;
  app = createPostgresClient({ connectionString: cluster.appUrl });
}, { timeout: 90_000 });

after(async () => {
  await app.close();
  await cluster.stop();
});

async function count(sqlText: string, params: unknown[] = []): Promise<number> {
  const { rows } = await owner.pool.query(sqlText, params);
  return Number((rows[0] as { n: string | number }).n);
}

test('F1/F2 reproduce on the simulated Supabase platform BEFORE hardening (the defect is real, not theoretical)', async () => {
  // F1: ensure_rls turned RLS on for a deliberately RLS-free table, leaving zero policies.
  for (const table of PLATFORM_GLOBAL_TABLES) {
    assert.equal(await count(`select count(*) as n from pg_class where relname = $1 and relrowsecurity`, [table]), 1, `${table}: RLS auto-enabled by the platform`);
    assert.equal(await count(`select count(*) as n from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = $1`, [table]), 0, `${table}: no policy`);
  }
  await owner.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('sim-owner-row', 'human', 'x', 'active')`);
  const visible = await app.pool.query('select * from identities');
  assert.equal(visible.rows.length, 0, 'runtime role sees nothing — the runtime would be broken');
  await assert.rejects(
    app.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('sim-app-row', 'human', 'x', 'active')`),
    (error: { code?: string }) => error.code === '42501',
  );

  // F2: default ACLs gave the client-facing roles full rights on every Samvardiq table.
  assert.ok(await count(`select count(*) as n from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon' and table_name = 'identities'`) > 0, 'anon holds table grants by default');
});

test('hardening repairs F1: samvardiq_app regains exactly the designed access to every platform-global table', async () => {
  await applySupabaseHardening(owner.pool);

  const visible = await app.pool.query('select identity_id from identities');
  assert.deepEqual(visible.rows.map((r: { identity_id: string }) => r.identity_id), ['sim-owner-row']);
  await app.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('sim-app-row', 'human', 'x', 'active')`);
  await app.pool.query(`insert into webhook_event_dedup (provider, external_event_id) values ('sim', 'evt-1')`);
  assert.equal((await app.pool.query('select 1 from webhook_event_dedup')).rows.length, 1);

  // Grants — not the permissive policy — still bound the runtime role: no DELETE on identities, no UPDATE on dedup.
  await assert.rejects(app.pool.query(`delete from identities where identity_id = 'sim-app-row'`), (error: { code?: string }) => error.code === '42501');
  await assert.rejects(app.pool.query(`update webhook_event_dedup set provider = 'x'`), (error: { code?: string }) => error.code === '42501');

  for (const table of PLATFORM_GLOBAL_TABLES) {
    assert.equal(await count(`select count(*) as n from pg_class where relname = $1 and relrowsecurity`, [table]), 1, `${table}: RLS stays enabled (deny-by-default for every other role)`);
  }
});

test('hardening repairs F2: anon and authenticated hold no privilege on any public table, sequence or Samvardiq function — and cannot actually read', async () => {
  for (const role of ['anon', 'authenticated']) {
    assert.equal(
      await count(`select count(*) as n from information_schema.role_table_grants where table_schema = 'public' and grantee = $1`, [role]),
      0,
      `${role}: no table privileges remain`,
    );
    assert.equal(
      await count(
        `select count(*) as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('enforce_approval_request_goal_consistency','prevent_approval_record_mutation','prevent_identity_audit_event_mutation')
            and has_function_privilege($1, p.oid, 'EXECUTE')`,
        [role],
      ),
      0,
      `${role}: cannot execute any Samvardiq function`,
    );
    // Behavioural, not just catalog: actually assume the role and try to read.
    const client = await owner.pool.connect();
    try {
      await client.query(`set role ${role}`);
      await assert.rejects(client.query('select * from identities'), (error: { code?: string }) => error.code === '42501');
      await assert.rejects(client.query('select * from organizations'), (error: { code?: string }) => error.code === '42501');
    } finally {
      await client.query('reset role');
      client.release();
    }
  }
  // service_role is a platform contract (server-only, never issued to Samvardiq components) and is deliberately not touched.
  assert.ok(await count(`select count(*) as n from information_schema.role_table_grants where table_schema = 'public' and grantee = 'service_role'`) > 0);
});

test('hardening is idempotent: re-applying changes nothing (one platform-global policy per table)', async () => {
  await applySupabaseHardening(owner.pool);
  await applySupabaseHardening(owner.pool);
  for (const table of PLATFORM_GLOBAL_TABLES) {
    assert.equal(
      await count(`select count(*) as n from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = $1 and p.polname = $2`, [table, PLATFORM_GLOBAL_POLICY]),
      1,
    );
  }
});

test('the platform-global list is exhaustive: every other public table keeps FORCE RLS and at least one tenant policy', async () => {
  const { rows } = await owner.pool.query(
    `select c.relname, c.relforcerowsecurity as forced, (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`,
  );
  const listed = new Set<string>(PLATFORM_GLOBAL_TABLES);
  const unlisted = (rows as { relname: string; forced: boolean; policies: number }[]).filter((r) => !listed.has(r.relname));
  assert.equal(unlisted.length, 12, '16 tables - 4 platform-global');
  for (const row of unlisted) {
    assert.equal(row.forced, true, `${row.relname}: FORCE RLS`);
    assert.ok(row.policies >= 1, `${row.relname}: tenant policy present`);
  }
});
