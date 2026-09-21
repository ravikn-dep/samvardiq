import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createPostgresClient } from '@samvardiq/data-foundation/dist/postgres/client.js';

import { connectDirect, connectViaSetRole, roleSwitchFailureCount, runBehaviorSuite, type ConnectAsRuntimeRole } from '../../scripts/behaviorChecks.js';
import { startLocalSupabaseCluster, type LocalSupabaseCluster } from '../../scripts/localSupabaseCluster.js';
import { Reporter } from '../../scripts/stagingDb.js';
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
  assert.equal(reporter.results.length, 16);
});

test('behaviour suite passes identically via the SET ROLE strategy used against staging, and is repeatable (cleanup left every table empty)', async () => {
  const reporter = new Reporter();
  await runBehaviorSuite(hardened.owner, connectViaSetRole(hardened.ownerUrl), reporter);
  assertAllPassed(reporter);
});

test('behaviour suite REFUSES to write when the database is not empty (protects real data), and does not clean it up', async () => {
  await hardened.owner.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('real-looking-row', 'human', 'x', 'active')`);
  try {
    const reporter = new Reporter();
    await runBehaviorSuite(hardened.owner, connectDirect(hardened.appUrl), reporter);
    assert.equal(reporter.results.length, 1);
    assert.equal(reporter.results[0]!.ok, false);
    const survived = await hardened.owner.pool.query(`select count(*)::int as n from identities where identity_id = 'real-looking-row'`);
    assert.equal((survived.rows[0] as { n: number }).n, 1, 'pre-existing data must never be truncated');
  } finally {
    await hardened.owner.pool.query(`delete from identities where identity_id = 'real-looking-row'`);
  }
});

test('behaviour suite on the unhardened database FAILS (proves F1 would have broken the runtime), and still cleans up', async () => {
  const reporter = new Reporter();
  await runBehaviorSuite(unhardened.owner, connectDirect(unhardened.appUrl), reporter);
  const failed = reporter.results.filter((r) => !r.ok).map((r) => r.id.split(' ')[0]);
  // The runtime role cannot provision an identity or a channel there: RLS-on-with-no-policy is deny-all.
  assert.ok(failed.includes('B6'), 'identity provisioning must fail without the F1 fix');
  assert.ok(failed.includes('B10'), 'channel creation must fail without the F1 fix');
  const leftover = await unhardened.owner.pool.query(`select count(*)::int as n from organizations`);
  assert.equal((leftover.rows[0] as { n: number }).n, 0, 'cleanup ran in finally even though the suite aborted');
});

test('cleanup REFUSES to TRUNCATE when a non-synthetic row appears after the precondition, and that row survives', async () => {
  const direct = connectDirect(hardened.appUrl);
  let injected = false;
  const injecting: ConnectAsRuntimeRole = (create) => {
    // connect() is called only after B0 passed, so this row appears mid-suite — the situation cleanup must not destroy.
    if (!injected) {
      injected = true;
      void hardened.owner.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('not-synthetic', 'human', 'x', 'active')`);
    }
    return direct(create);
  };
  const reporter = new Reporter();
  try {
    await runBehaviorSuite(hardened.owner, injecting, reporter);
    const failed = reporter.results.filter((r) => !r.ok).map((r) => r.id.split(' ')[0]);
    assert.ok(failed.includes('B13'), 'synthetic-only proof must flag the foreign row');
    assert.ok(failed.includes('B15'), 'cleanup must refuse');
    const survived = await hardened.owner.pool.query(`select count(*)::int as n from identities where identity_id = 'not-synthetic'`);
    assert.equal((survived.rows[0] as { n: number }).n, 1, 'the non-synthetic row must NOT have been truncated');
  } finally {
    await hardened.owner.pool.query('TRUNCATE TABLE public.identities, public.organizations CASCADE'); // test hygiene only
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
