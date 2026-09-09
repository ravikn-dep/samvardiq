import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Goal } from '@samvardiq/data-foundation';

import { handleListGoalsRequest } from '../src/protectedGoalListHandler.js';
import { buildWorld, provisionMember } from './setup.js';

/**
 * Section 14 (request isolation) + Y/Z + section 31 (concurrency). The
 * design explicitly uses plain explicit dependency passing, not
 * AsyncLocalStorage or any module/singleton mutable state (see
 * requestBoundary.ts / organizationAccess.ts — every function is a pure
 * async function returning a fresh value per call). These tests fire
 * many concurrent requests through the SAME shared dependency object
 * (the realistic case — one process serving many requests) and prove no
 * cross-contamination is possible, which follows from that design but is
 * proven here rather than merely asserted.
 */

test('Y: concurrent Org A and Org B requests on shared dependencies never cross-contaminate results', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-A', subject: 'sub-A', organizationId: 'org-A' });
  await provisionMember(world, { identityId: 'id-B', subject: 'sub-B', organizationId: 'org-B' });
  await world.goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'x', description: 'x' });
  await world.goals.create({ goalId: 'goal-B', organizationId: 'org-B', title: 'x', description: 'x' });
  const tokenA = await world.issuer.signToken({ sub: 'sub-A' });
  const tokenB = await world.issuer.signToken({ sub: 'sub-B' });

  const [resultsA, resultsB] = await Promise.all([
    Promise.all(
      Array.from({ length: 25 }, () =>
        handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${tokenA}`, requestedOrganizationId: 'org-A' }),
      ),
    ),
    Promise.all(
      Array.from({ length: 25 }, () =>
        handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${tokenB}`, requestedOrganizationId: 'org-B' }),
      ),
    ),
  ]);

  for (const goals of resultsA) assert.deepEqual(goals.map((g) => g.goalId), ['goal-A']);
  for (const goals of resultsB) assert.deepEqual(goals.map((g) => g.goalId), ['goal-B']);
});

test('Z: no shared mutable state lets one request\'s context be reused as another\'s — the same identity resolves independently per call', async () => {
  const world = await buildWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.memberships.create({ organizationId: 'org-A', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });
  // deliberately NOT a member of org-B
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  // Interleave an authorized org-A call with an unauthorized org-B call for the SAME identity,
  // many times, to try to provoke any accidental reuse of a previously-established context.
  const calls = Array.from({ length: 30 }, (_, i) =>
    i % 2 === 0
      ? handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }).then((r) => ({ ok: true as const, r }))
      : handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-B' }).then(
          () => ({ ok: true as const, r: [] }),
          () => ({ ok: false as const, r: [] }),
        ),
  );
  const results = await Promise.all(calls);

  results.forEach((result, i) => {
    if (i % 2 === 0) {
      assert.equal(result.ok, true, 'org-A request must always succeed');
    } else {
      assert.equal(result.ok, false, 'org-B request must always be denied — never inherits the org-A context established moments earlier');
    }
  });
});

test('section 31: 50+ concurrent mixed requests (Org A / Org B / unauthorized Org C) preserve tenant isolation and authorization', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-A', subject: 'sub-A', organizationId: 'org-A' });
  await provisionMember(world, { identityId: 'id-B', subject: 'sub-B', organizationId: 'org-B' });
  await world.organizations.create({ organizationId: 'org-C', organizationType: 'clinic', name: 'org-C' }); // exists, but neither identity is a member
  await world.goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'x', description: 'x' });
  await world.goals.create({ goalId: 'goal-B', organizationId: 'org-B', title: 'x', description: 'x' });
  const tokenA = await world.issuer.signToken({ sub: 'sub-A' });
  const tokenB = await world.issuer.signToken({ sub: 'sub-B' });

  type Case = { label: 'A' | 'B' | 'C-via-A' | 'C-via-B'; token: string; org: string; shouldSucceed: boolean };
  const caseTemplate: Case[] = [
    { label: 'A', token: tokenA, org: 'org-A', shouldSucceed: true },
    { label: 'B', token: tokenB, org: 'org-B', shouldSucceed: true },
    { label: 'C-via-A', token: tokenA, org: 'org-C', shouldSucceed: false },
    { label: 'C-via-B', token: tokenB, org: 'org-C', shouldSucceed: false },
  ];
  const cases = Array.from({ length: 15 }, () => caseTemplate).flat(); // 60 total requests

  const outcomes = await Promise.all(
    cases.map((c) =>
      handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${c.token}`, requestedOrganizationId: c.org }).then(
        (goals) => ({ c, ok: true as const, goals }),
        () => ({ c, ok: false as const, goals: [] as Goal[] }),
      ),
    ),
  );

  assert.equal(outcomes.length, 60);
  for (const outcome of outcomes) {
    assert.equal(outcome.ok, outcome.c.shouldSucceed, `case ${outcome.c.label} authorization outcome mismatch`);
    if (outcome.c.label === 'A') assert.deepEqual(outcome.goals.map((g) => g.goalId), ['goal-A']);
    if (outcome.c.label === 'B') assert.deepEqual(outcome.goals.map((g) => g.goalId), ['goal-B']);
  }
});
