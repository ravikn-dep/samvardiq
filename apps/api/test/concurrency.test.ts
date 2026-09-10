import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWorld, provisionMember } from './setup.js';

/**
 * AS/AT: the HTTP-layer mirror of application-services'
 * `test/isolation.test.ts` "section 31" concurrency proof — fired through
 * real `.inject()` requests against one shared Fastify instance (the
 * realistic case: one process serving many concurrent HTTP requests) rather
 * than by calling the boundary function directly.
 */

test('AS/AT: 60 concurrent mixed-tenant real HTTP requests (Org A / Org B / unauthorized Org C) preserve tenant isolation and never contaminate an authorized result with an unauthorized one', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-A', subject: 'sub-A', organizationId: 'org-A' });
  await provisionMember(world, { identityId: 'id-B', subject: 'sub-B', organizationId: 'org-B' });
  await world.organizations.create({ organizationId: 'org-C', organizationType: 'clinic', name: 'org-C' });
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
  const cases = Array.from({ length: 15 }, () => caseTemplate).flat(); // 60 concurrent HTTP requests

  const outcomes = await Promise.all(
    cases.map((c) =>
      world.app
        .inject({ method: 'GET', url: `/v1/organizations/${c.org}/goals`, headers: { authorization: `Bearer ${c.token}` } })
        .then((res) => ({ c, res })),
    ),
  );

  assert.equal(outcomes.length, 60);
  for (const { c, res } of outcomes) {
    if (c.shouldSucceed) {
      assert.equal(res.statusCode, 200, `case ${c.label} should succeed`);
      const goalIds = res.json().map((g: { goalId: string }) => g.goalId);
      if (c.label === 'A') assert.deepEqual(goalIds, ['goal-A']);
      if (c.label === 'B') assert.deepEqual(goalIds, ['goal-B']);
    } else {
      assert.equal(res.statusCode, 403, `case ${c.label} should be denied`);
    }
  }

  await world.app.close();
});
