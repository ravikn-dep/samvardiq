import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { startLocalSupabaseCluster, type LocalSupabaseCluster } from '../../scripts/localSupabaseCluster.js';
import { Reporter } from '../../scripts/stagingDb.js';
import { withTemporarySetRole } from '../../scripts/temporaryRoleGrant.js';

/**
 * INFRA-W1B: the founder-authorized temporary `GRANT samvardiq_app TO postgres
 * WITH SET TRUE` must never survive a session, whatever happens inside it.
 * Proven here on a disposable Supabase-shaped cluster, including the exact
 * staging topology (a pre-existing, platform-granted non-SET membership
 * edge that the revocation must leave untouched).
 */

let cluster: LocalSupabaseCluster;

before(async () => {
  cluster = await startLocalSupabaseCluster(55953, { migrate: true, harden: true });
  // Stand-in for Supabase's `supabase_admin`: the platform role that granted `postgres` its pre-existing, non-SET membership.
  // (Real staging's edge also carries ADMIN OPTION; PostgreSQL forbids granting ADMIN back up a grantor chain, so the rehearsal edge omits it — the code path, a distinct edge with a different grantor, is identical.)
  await cluster.owner.pool.query('CREATE ROLE sim_platform SUPERUSER');
  await cluster.owner.pool.query('GRANT samvardiq_app TO sim_platform WITH ADMIN OPTION');
}, { timeout: 120_000 });

after(async () => {
  await cluster.stop();
});

const edges = async () =>
  (await cluster.owner.pool.query(
    `select pg_get_userbyid(m.grantor) as grantor, m.admin_option as admin, m.inherit_option as inherit, m.set_option as set
       from pg_auth_members m where m.roleid = 'samvardiq_app'::regrole and m.member = 'postgres'::regrole order by 1, 2, 3, 4`,
  )).rows;
// The rehearsal cluster's `postgres` is a superuser (pg_has_role is always true for it), so measure the explicit SET-option edge.
const canSet = async () => ((await cluster.owner.pool.query(`select exists (select 1 from pg_auth_members m where m.roleid = 'samvardiq_app'::regrole and m.member = 'postgres'::regrole and m.set_option) as v`)).rows[0] as { v: boolean }).v;

beforeEach(async () => {
  // Start every test from "postgres has no membership in samvardiq_app".
  await cluster.owner.pool.query('REVOKE samvardiq_app FROM postgres');
  await cluster.owner.pool.query('REVOKE samvardiq_app FROM postgres GRANTED BY sim_platform');
  await cluster.owner.pool.query('ALTER ROLE samvardiq_app NOCREATEDB');
});

test('staging topology: a pre-existing platform-granted non-SET edge is preserved; only the temporary edge is revoked; SET works only inside', async () => {
  await cluster.owner.pool.query('GRANT samvardiq_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET FALSE GRANTED BY sim_platform');
  const before = await edges();
  assert.equal(before.length, 1);
  assert.equal(before[0]!.grantor, 'sim_platform');
  assert.equal(await canSet(), false);

  const reporter = new Reporter();
  let setInside = false;
  const outcome = await withTemporarySetRole(cluster.owner, reporter, async () => {
    setInside = await canSet();
    assert.equal((await edges()).length, 2, 'the temporary grant is a separate edge');
  });

  assert.equal(setInside, true);
  assert.equal(outcome.securityFailure, false);
  assert.deepEqual(reporter.results.filter((r) => !r.ok), []);
  assert.deepEqual(await edges(), before, 'membership edges identical to the pre-grant record');
  assert.equal(await canSet(), false);
  assert.deepEqual(reporter.results.map((r) => r.id.split(' ')[0]), ['P1', 'P2', 'R1', 'R2', 'R3']);
});

test('an existing edge with the same grantor is restored in place (SET option dropped, the rest kept)', async () => {
  await cluster.owner.pool.query('GRANT samvardiq_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET FALSE');
  const before = await edges();
  const reporter = new Reporter();
  const outcome = await withTemporarySetRole(cluster.owner, reporter, async () => {
    assert.equal(await canSet(), true);
  });
  assert.equal(outcome.securityFailure, false);
  assert.deepEqual(reporter.results.filter((r) => !r.ok), []);
  assert.deepEqual(await edges(), before);
});

test('with no pre-existing membership at all, nothing remains afterwards', async () => {
  const reporter = new Reporter();
  const outcome = await withTemporarySetRole(cluster.owner, reporter, async () => {
    assert.equal(await canSet(), true);
  });
  assert.equal(outcome.securityFailure, false);
  assert.deepEqual(await edges(), []);
  assert.equal(await canSet(), false);
});

test('a suite that throws still gets the grant revoked, and the abort is recorded as a failed check (never swallowed)', async () => {
  const reporter = new Reporter();
  const outcome = await withTemporarySetRole(cluster.owner, reporter, async () => {
    throw new Error('simulated mid-suite crash');
  });
  assert.equal(outcome.securityFailure, false, 'revocation itself succeeded');
  assert.deepEqual(await edges(), []);
  assert.equal(await canSet(), false);
  assert.ok(reporter.results.some((r) => r.id.startsWith('W0') && !r.ok), 'the abort must be visible as a failed check');
});

test('a failed pre-grant check (samvardiq_app already gained CREATEDB) means NO grant is ever issued and the work never runs', async () => {
  await cluster.owner.pool.query('ALTER ROLE samvardiq_app CREATEDB');
  const reporter = new Reporter();
  let ran = false;
  const outcome = await withTemporarySetRole(cluster.owner, reporter, async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(outcome.securityFailure, false);
  assert.deepEqual(await edges(), [], 'no grant was issued');
  assert.equal(reporter.results[0]!.ok, false);
  assert.equal(reporter.results.length, 1);
});
