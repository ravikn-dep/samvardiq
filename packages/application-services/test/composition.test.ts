import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleListGoalsRequest } from '../src/protectedGoalListHandler.js';
import { assertDenied, buildWorld, provisionMember } from './setup.js';

/**
 * H-R, U, V, X, AE, AG, AH, AJ: the authorization half of the
 * adversarial matrix — real cryptographic authentication (via the real
 * SupabaseIdentityProviderAdapter + a real signed token, per section 32:
 * "do not mock the exact boundary a test claims to prove") composed with
 * the real, unmodified AuthorizationService, exercised entirely through
 * this session's new `handleListGoalsRequest` request boundary. Every
 * denial case asserts the specific FORBIDDEN classification, not merely
 * "the promise rejected" (see setup.ts's `assertDenied`).
 */

test('H: valid auth with no provider link is denied', async () => {
  const world = await buildWorld();
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'unlinked-subject' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('I: valid auth for a suspended identity is denied', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.identities.updateStatus('id-1', 'suspended');
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('J: valid auth for a revoked identity is denied', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.identities.updateStatus('id-1', 'revoked');
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('K: valid auth with no organization membership is denied', async () => {
  const world = await buildWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('L: an INVITED (not yet active) membership is denied', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'INVITED' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('M: a SUSPENDED membership is denied', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'SUSPENDED' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('N: a REVOKED membership is denied', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'REVOKED' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('O: an Org A member requesting Org B is denied', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-B' }),
    'FORBIDDEN',
  );
});

test('P: a valid Org A request reaches the protected service and returns Org A data only', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.goals.create({ goalId: 'goal-1', organizationId: 'org-A', title: 'Grow appointments', description: 'x' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const goals = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  assert.equal(goals.length, 1);
  assert.equal(goals[0]!.organizationId, 'org-A');
});

test('Q: a multi-organization identity may access A and B independently, never bleeding data across', async () => {
  const world = await buildWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.memberships.create({ organizationId: 'org-A', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });
  await world.memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });
  await world.goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'A goal', description: 'x' });
  await world.goals.create({ goalId: 'goal-B', organizationId: 'org-B', title: 'B goal', description: 'x' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const goalsA = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  const goalsB = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-B' });

  assert.deepEqual(goalsA.map((g) => g.goalId), ['goal-A']);
  assert.deepEqual(goalsB.map((g) => g.goalId), ['goal-B']);
});

test('R: merely knowing/guessing a real organizationId grants nothing without a real membership', async () => {
  const world = await buildWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  // org-A genuinely exists (an attacker could learn/guess its id) but id-1 has no membership in it.
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('U: the verified provider subject cannot be substituted for the internal identityId', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  // A membership keyed on the raw subject (rather than the real identityId) must not exist / must not be found.
  assert.equal(await world.memberships.get('org-A', 'sub-1'), undefined);

  const goals = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  assert.deepEqual(goals, []); // resolves via id-1, not via the subject string
});

test('V: no email claim reaches VerifiedPrincipal or TrustedOrganizationContext, so it cannot establish access', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' }); // this package's test issuer never embeds email at all
  const goals = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  assert.deepEqual(goals, []); // access was granted by membership, not by any email claim (which does not exist here)
});

test('X: the protected service is never invoked for any authorization failure', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'SUSPENDED' });
  let calls = 0;
  const original = world.goalReadService.listGoals.bind(world.goalReadService);
  world.goalReadService.listGoals = async (context) => {
    calls += 1;
    return original(context);
  };
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
  assert.equal(calls, 0);
});

test('AE: a service principal authenticating through the same boundary resolves as principalType "service", never elevated to "human"', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'svc-1', subject: 'svc-sub-1', organizationId: 'org-A', principalType: 'service' });
  const token = await world.issuer.signToken({ sub: 'svc-sub-1' });

  // Prove via the boundary's own composition primitive (not GoalReadService, which doesn't expose principalType)
  const { resolveOrganizationAccess } = await import('../src/organizationAccess.js');
  const principal = await world.deps.identityProvider.verifyCredential({ rawToken: token });
  const context = await resolveOrganizationAccess(world.authz, world.organizations, principal, 'org-A');
  assert.equal(context.principalType, 'service');
  assert.equal(context.approverRole, undefined);
});

test('AG: revoking membership after a valid token was issued denies the very next request through this boundary', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const first = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  assert.deepEqual(first, []);

  await world.memberships.updateStatus('org-A', 'id-1', 'REVOKED');

  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('AH: suspending the identity after a valid token was issued denies the very next request through this boundary', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const first = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  assert.deepEqual(first, []);

  await world.identities.updateStatus('id-1', 'suspended');

  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'FORBIDDEN',
  );
});

test('AJ: a VIEWER (lowest organization role, no approverRole) can still read goals — organization access is not approval authority', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'VIEWER' });
  await world.goals.create({ goalId: 'goal-1', organizationId: 'org-A', title: 'x', description: 'x' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const goals = await handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' });
  assert.equal(goals.length, 1); // VIEWER role, no approverRole at all, is sufficient — approval authority is a separate concern
});
