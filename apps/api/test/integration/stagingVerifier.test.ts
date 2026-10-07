import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createPostgresClient } from '@samvardiq/data-foundation/dist/postgres/client.js';

import { connectDirect, connectViaSetRole, roleSwitchFailureCount, runBehaviorSuite, type ConnectAsRuntimeRole } from '../../scripts/behaviorChecks.js';
import { startLocalSupabaseCluster, type LocalSupabaseCluster } from '../../scripts/localSupabaseCluster.js';
import { Reporter } from '../../scripts/stagingDb.js';
import { provisionHumanOwner } from '../../scripts/provisionHumanOwner.js';
import { acquireVerifierLock, cleanupRun, SYNTHETIC_PROBES } from '../../scripts/syntheticRun.js';
import { runStructureChecks } from '../../scripts/structureChecks.js';

/**
 * INFRA-W1B: the staging verifier is itself code that gates a deployment, so
 * it is proven here against disposable clusters shaped like Supabase — that it
 * PASSES on the correct (migrated + hardened) schema in both of its runtime-
 * role strategies, and FAILS on the defective (migrated-only) schema that
 * real staging exhibited before the hardening. A verifier that cannot fail is
 * not evidence.
 */

let hardened: LocalSupabaseCluster;
let unhardened: LocalSupabaseCluster;

before(async () => {
  hardened = await startLocalSupabaseCluster(55951, { migrate: true, harden: true });
  unhardened = await startLocalSupabaseCluster(55952, { migrate: true, harden: false });
}, { timeout: 180_000 });

after(async () => {
  await hardened.stop();
  await unhardened.stop();
});

function assertAllPassed(reporter: Reporter): void {
  assert.deepEqual(reporter.results.filter((r) => !r.ok), []);
}

test('structure checks pass on a correctly migrated + hardened Supabase-shaped database', async () => {
  const reporter = new Reporter();
  await runStructureChecks(hardened.owner, reporter);
  assertAllPassed(reporter);
  assert.ok(reporter.results.length >= 10);
});

test('structure checks FAIL on the migrated-only database (F1: platform-global tables deny-all, F2: anon/authenticated exposed)', async () => {
  const reporter = new Reporter();
  await runStructureChecks(unhardened.owner, reporter);
  const failed = reporter.results.filter((r) => !r.ok).map((r) => r.id.split(' ')[0]);
  assert.ok(failed.includes('S6'), 'S6 must catch the platform-global tables left with RLS and no policy');
  assert.ok(failed.includes('E1'), 'E1 must catch anon/authenticated privileges');
});

test('behaviour suite passes end to end as samvardiq_app via direct login, and cleans up after itself', async () => {
  const reporter = new Reporter();
  await runBehaviorSuite(hardened.owner, connectDirect(hardened.appUrl), reporter);
  assertAllPassed(reporter);
  assert.equal(reporter.results.length, 18, 'B0-B17');
});

test('behaviour suite passes identically via the SET ROLE strategy used against staging, and is repeatable', async () => {
  const reporter = new Reporter();
  await runBehaviorSuite(hardened.owner, connectViaSetRole(hardened.ownerUrl), reporter);
  assertAllPassed(reporter);
});

test('behaviour suite on the unhardened database FAILS (proves F1 would have broken the runtime), and still cleans up', async () => {
  const reporter = new Reporter();
  await runBehaviorSuite(unhardened.owner, connectDirect(unhardened.appUrl), reporter);
  const failed = reporter.results.filter((r) => !r.ok).map((r) => r.id.split(' ')[0]);
  // The runtime role cannot provision an identity or a channel there: RLS-on-with-no-policy is deny-all.
  assert.ok(failed.includes('B6'), 'identity provisioning must fail without the F1 fix');
  assert.ok(failed.includes('B10'), 'channel creation must fail without the F1 fix');
  assert.ok(reporter.results.find((r) => r.id.startsWith('B15'))?.ok, 'cleanup ran in finally even though the suite aborted, and left nothing outside the run changed');
});

// ---- D5 (IDENTITY-SUPABASE-AUTH-STAGING): the suite must coexist with legitimate, persistent staging data ----------

const OWNER = { organizationId: 'org-real-clinic', organizationName: 'Real Clinic', identityId: 'real-founder', displayName: 'Real Founder', providerSubject: '89799c2f-0000-4b46-baa1-000000000001' };

async function legitimateSnapshot(cluster: LocalSupabaseCluster): Promise<string> {
  const q = async (sql: string) => JSON.stringify((await cluster.owner.pool.query(sql)).rows);
  return [
    await q(`select * from organizations where organization_id not like 'w1b-%' order by 1`),
    await q(`select * from identities where identity_id not like 'w1b-%' order by 1`),
    await q(`select * from identity_provider_links where identity_id not like 'w1b-%' order by 2`),
    await q(`select * from organization_memberships where organization_id not like 'w1b-%' order by 1, 2`),
    await q(`select * from identity_audit_events where coalesce(organization_id, target_id) not like 'w1b-%' order by event_id`),
    await q(`select * from goals where organization_id not like 'w1b-%' order by 1, 2`),
  ].join('\n');
}

async function syntheticRowCount(cluster: LocalSupabaseCluster): Promise<number> {
  let n = 0;
  for (const [table, probe] of Object.entries(SYNTHETIC_PROBES)) {
    n += Number((await cluster.owner.pool.query(`select count(*)::int as n from public.${table} where left(coalesce((${probe})::text, ''), 4) = 'w1b-'`)).rows[0].n);
  }
  return n;
}

test('D5: legitimate persistent data (a bootstrapped human OWNER with audit history, plus a goal) survives two full suite runs byte-identical; retained synthetic rows are namespaced and bounded; the OWNER still resolves', async () => {
  assert.equal(await provisionHumanOwner(hardened.owner, OWNER, true), 'provisioned');
  await hardened.owner.pool.query(`insert into goals (organization_id, goal_id, title, description, status) values ($1, 'real-goal', 'Grow', 'Real goal', 'active')`, [OWNER.organizationId]);
  const before = await legitimateSnapshot(hardened);
  const synthetic0 = await syntheticRowCount(hardened);
  try {
    const counts: number[] = [];
    for (let run = 1; run <= 2; run += 1) {
      const reporter = new Reporter();
      await runBehaviorSuite(hardened.owner, connectDirect(hardened.appUrl), reporter);
      assertAllPassed(reporter);
      assert.equal(reporter.results.length, 18);
      assert.equal(await legitimateSnapshot(hardened), before, `run ${run}: legitimate rows unchanged`);
      counts.push(await syntheticRowCount(hardened));
    }
    const perRun = counts[0]! - synthetic0;
    assert.ok(perRun > 0, 'immutable audit rows (and the rows they reference) are retained, not forced away');
    assert.equal(counts[1]! - counts[0]!, perRun, 'retention is bounded: every run keeps exactly the same number of namespaced rows');
    // The OWNER is still usable after verification: provider subject → identity → ACTIVE OWNER membership.
    const owner = await hardened.owner.pool.query(
      `select m.role, m.status, i.status as identity_status from identity_provider_links l join identities i using (identity_id) join organization_memberships m using (identity_id) where l.provider = 'supabase' and l.provider_subject = $1`,
      [OWNER.providerSubject],
    );
    assert.deepEqual(owner.rows, [{ role: 'OWNER', status: 'ACTIVE', identity_status: 'active' }]);
    assert.equal(await provisionHumanOwner(hardened.owner, OWNER, true), 'already-provisioned');
  } finally {
    // Test hygiene only (a disposable local cluster) — never something the verifier itself does.
    await hardened.owner.pool.query('TRUNCATE TABLE public.organizations, public.identities, public.identity_provider_links, public.organization_memberships, public.identity_audit_events, public.goals CASCADE');
  }
});

test('D5: a legitimate row written by someone else DURING a run is flagged (B13/B15) and never deleted', async () => {
  const direct = connectDirect(hardened.appUrl);
  let injected = false;
  const injecting: ConnectAsRuntimeRole = (create) => {
    // connect() is called only after B0 fingerprinted the database, so this row appears mid-run.
    if (!injected) {
      injected = true;
      void hardened.owner.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('legit-mid-run', 'human', 'x', 'active')`);
    }
    return direct(create);
  };
  const reporter = new Reporter();
  try {
    await runBehaviorSuite(hardened.owner, injecting, reporter);
    const failed = reporter.results.filter((r) => !r.ok).map((r) => r.id.split(' ')[0]);
    assert.ok(failed.includes('B13') && failed.includes('B15'), `isolation proofs must flag the foreign row (failed: ${failed.join(',')})`);
    const survived = await hardened.owner.pool.query(`select count(*)::int as n from identities where identity_id = 'legit-mid-run'`);
    assert.equal(Number(survived.rows[0].n), 1, 'the legitimate row was not deleted');
  } finally {
    await hardened.owner.pool.query(`delete from identities where identity_id = 'legit-mid-run'`);
  }
});

test('D5: cleanup fails closed on any namespace that is not exactly one run prefix, before touching anything', async () => {
  await hardened.owner.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('w1b-legacy-row', 'human', 'x', 'active'), ('legit-row', 'human', 'x', 'active')`);
  try {
    for (const bad of ['', 'w1b-', '%', 'w1b-%', 'w1b-zzzzzzzz-', 'w1b-0000000-', 'legit-', 'w1b-00000000']) {
      await assert.rejects(cleanupRun(hardened.owner, ['identities'], bad), /exactly one run prefix/, JSON.stringify(bad));
    }
    const left = await hardened.owner.pool.query(`select identity_id from identities where identity_id in ('w1b-legacy-row', 'legit-row') order by 1`);
    assert.deepEqual(left.rows.map((r) => r.identity_id), ['legit-row', 'w1b-legacy-row']);
  } finally {
    await hardened.owner.pool.query(`delete from identities where identity_id in ('w1b-legacy-row', 'legit-row')`);
  }
});

test('D5: cleanup deletes only the current run`s rows — never legitimate rows, never another run`s rows; immutable rows and their referenced parents are kept', async () => {
  const run = 'w1b-0a0a0a0a-';
  const other = 'w1b-0b0b0b0b-';
  const q = (sql: string, params: unknown[] = []) => hardened.owner.pool.query(sql, params);
  for (const id of [`${run}actor`, `${run}plain`, `${other}actor`, 'legit-actor']) await q(`insert into identities (identity_id, principal_type, display_name, status) values ($1, 'human', 'x', 'active')`, [id]);
  // An immutable audit row of THIS run referencing a run identity (FK) — both must be kept, not forced.
  await q(`insert into identity_audit_events (event_id, organization_id, actor_identity_id, actor_principal_type, event_type, target_type, target_id, outcome) values ('e1', null, $1, 'human', 'IDENTITY_CREATED', 'IDENTITY', $2, 'SUCCESS')`, [`${run}actor`, `${run}actor`]);
  try {
    const result = await cleanupRun(hardened.owner, ['identities', 'identity_audit_events'], run);
    assert.deepEqual(result, { deleted: 1, immutable: { identity_audit_events: 1 }, referenced: { identities: 1 } });
    const ids = (await q(`select identity_id from identities where identity_id in ($1, $2, $3, $4) order by 1`, [`${run}actor`, `${run}plain`, `${other}actor`, 'legit-actor'])).rows.map((r) => r.identity_id);
    assert.deepEqual(ids, ['legit-actor', `${run}actor`, `${other}actor`]);
    // Repeating the cleanup is safe and changes nothing.
    assert.deepEqual(await cleanupRun(hardened.owner, ['identities', 'identity_audit_events'], run), { deleted: 0, immutable: { identity_audit_events: 1 }, referenced: { identities: 1 } });
  } finally {
    await q(`TRUNCATE TABLE public.identity_audit_events`); // test hygiene only
    await q(`delete from identities where identity_id in ($1, $2, $3, $4)`, [`${run}actor`, `${run}plain`, `${other}actor`, 'legit-actor']);
  }
});

test('D5: a second verifier run cannot start while one holds the verifier lock — it writes nothing', async () => {
  const synthetic = await syntheticRowCount(hardened);
  const release = await acquireVerifierLock(hardened.owner);
  try {
    const reporter = new Reporter();
    await runBehaviorSuite(hardened.owner, connectDirect(hardened.appUrl), reporter);
    assert.equal(reporter.results.length, 1);
    assert.equal(reporter.results[0]!.ok, false);
    assert.equal(await syntheticRowCount(hardened), synthetic, 'nothing was written');
  } finally {
    await release();
  }
});

test('a failed SET ROLE is counted (so the suite fails) instead of silently serving queries as the login role', async () => {
  await hardened.owner.pool.query(`create role w1b_probe login password 'w1b-probe-pw' nosuperuser`);
  try {
    const url = hardened.ownerUrl.replace('postgres:postgres@', 'w1b_probe:w1b-probe-pw@');
    const before = roleSwitchFailureCount();
    const client = connectViaSetRole(url)((config) => createPostgresClient(config));
    await client.pool.query('select 1').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.pool.end().catch(() => undefined);
    assert.equal(roleSwitchFailureCount(), before + 1);
  } finally {
    await hardened.owner.pool.query('drop role w1b_probe');
  }
});

test('structure checks detect a leftover temporary SET grant (e.g. the verifier process was killed mid-session)', async () => {
  await hardened.owner.pool.query('GRANT samvardiq_app TO postgres WITH SET TRUE');
  try {
    const reporter = new Reporter();
    await runStructureChecks(hardened.owner, reporter);
    assert.deepEqual(reporter.results.filter((r) => !r.ok).map((r) => r.id.split(' ')[0]), ['S8']);
  } finally {
    await hardened.owner.pool.query('REVOKE samvardiq_app FROM postgres');
  }
});
