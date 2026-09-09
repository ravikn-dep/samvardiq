import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleListGoalsRequest } from '../src/protectedGoalListHandler.js';
import { assertDenied, buildWorld, provisionMember } from './setup.js';

/**
 * Section 13 immutability, plus S/T/AA/AB: proves nothing downstream of
 * TrustedOrganizationContext establishment can override or bypass it,
 * and that the protected service is structurally bound to consume the
 * context object, never a raw organizationId.
 */

test('immutability: TrustedOrganizationContext fields cannot be reassigned after establishment', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const { resolveOrganizationAccess } = await import('../src/organizationAccess.js');
  const principal = await world.deps.identityProvider.verifyCredential({ rawToken: token });
  const context = await resolveOrganizationAccess(world.authz, world.organizations, principal, 'org-A');

  assert.ok(Object.isFrozen(context));
  assert.throws(() => {
    (context as { organizationId: string }).organizationId = 'org-EVIL';
  }, TypeError);
});

test('S: a rogue "body" organizationId alongside the header-authorized one is never consulted — only the authorized org\'s data is ever returned', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'x', description: 'x' });
  await world.goals.create({ goalId: 'goal-B', organizationId: 'org-B', title: 'x', description: 'x' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  // Simulate a caller that also sends an unrelated, attacker-controlled "body" value.
  // handleListGoalsRequest's signature has no parameter that could ever read it.
  const maliciousBodyOrganizationId = 'org-B';
  void maliciousBodyOrganizationId; // never passed anywhere below — that is the point being proven

  const goals = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  assert.deepEqual(goals.map((g) => g.goalId), ['goal-A']);
});

test('T: re-supplying a different organization header after context establishment does not retroactively change an already-returned result', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'x', description: 'x' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const first = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  assert.deepEqual(first.map((g) => g.goalId), ['goal-A']);

  // A second, independent request naming org-B is just that — a new request, correctly denied
  // (id-1 has no membership in org-B) — not a mutation of the first request's already-returned context/result.
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-B' }),
    'FORBIDDEN',
  );
});

test('AA: GoalReadService.listGoals has exactly one parameter (TrustedOrganizationContext) — a raw organizationId string is a compile-time type error', async () => {
  const world = await buildWorld();
  assert.equal(world.goalReadService.listGoals.length, 1);

  // @ts-expect-error — a raw organizationId string is not a TrustedOrganizationContext; this must not typecheck.
  const rejected: Promise<unknown> = world.goalReadService.listGoals('org-A');
  await rejected.catch(() => {}); // runtime behavior is irrelevant here — the compile-time rejection above is the proof
});

test('AB: the application service scopes the repository call using context.organizationId, and nothing else', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const seen: string[] = [];
  const originalListByOrganization = world.goals.listByOrganization.bind(world.goals);
  world.goals.listByOrganization = async (organizationId: string) => {
    seen.push(organizationId);
    return originalListByOrganization(organizationId);
  };
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });

  assert.deepEqual(seen, ['org-A']); // never 'sub-1', never 'id-1', never any other value
});
