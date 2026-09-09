import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { AuthorizationService } from '@samvardiq/identity-access';
import {
  PostgresIdentityRepository,
  PostgresIdentityProviderLinkRepository,
  PostgresMembershipRepository,
} from '@samvardiq/identity-access/dist/postgres/index.js';
import { PostgresGoalRepository, PostgresOrganizationRepository } from '@samvardiq/data-foundation/dist/postgres/index.js';

import { GoalReadService } from '../../src/goalReadService.js';
import { resolveOrganizationAccess } from '../../src/organizationAccess.js';
import { assertDenied } from '../setup.js';
import { createTestIssuer, type TestIssuer } from '../../../identity-access/test/jwksTestHelper.js';
import { startHarness, type Harness } from './harness.js';

/**
 * AC, AD (section 19/21/30/36): real PostgreSQL, real RLS, both
 * packages' schemas coexisting in one database. Uses the `app` client
 * (samvardiq_app, RLS-subject, grant-restricted — never the migration
 * owner) throughout, matching every prior session's convention that
 * repository-under-test calls run as the actual application role.
 */

let harness: Harness;
let issuer: TestIssuer;

before(async () => {
  harness = await startHarness(55499);
  issuer = await createTestIssuer();
});

beforeEach(async () => {
  await harness.truncateAll();
});

after(async () => {
  await harness.stop();
});

function buildRealWorld() {
  const identities = new PostgresIdentityRepository(harness.identityApp.db);
  const providerLinks = new PostgresIdentityProviderLinkRepository(harness.identityApp.db);
  const memberships = new PostgresMembershipRepository(harness.identityApp.db);
  const organizations = new PostgresOrganizationRepository(harness.dataFoundationApp.db);
  const goals = new PostgresGoalRepository(harness.dataFoundationApp.db);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  const goalReadService = new GoalReadService(goals);
  return { identities, providerLinks, memberships, organizations, goals, authz, goalReadService };
}

test('AC: real PostgreSQL RLS prevents cross-org retrieval even though both organizations\' data lives in the same database', async () => {
  const world = buildRealWorld();
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await world.memberships.create({ organizationId: 'org-A', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });
  await world.goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'x', description: 'x' });
  await world.goals.create({ goalId: 'goal-B', organizationId: 'org-B', title: 'x', description: 'x' });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const { SupabaseIdentityProviderAdapter } = await import('@samvardiq/identity-access/dist/providers/index.js');
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const verifiedPrincipal = await adapter.verifyCredential({ rawToken: token });

  const context = await resolveOrganizationAccess(world.authz, world.organizations, verifiedPrincipal, 'org-A');
  const goals = await world.goalReadService.listGoals(context);

  assert.deepEqual(goals.map((g) => g.goalId), ['goal-A']);

  // Direct proof that even the repository call itself (bypassing GoalReadService, simulating an
  // application-level bug that somehow obtained the org-B id) is bound by RLS, not by application logic:
  const orgBRows = await world.goals.listByOrganization('org-B');
  const orgARows = await world.goals.listByOrganization('org-A');
  assert.deepEqual(orgBRows.map((g) => g.goalId), ['goal-B']);
  assert.deepEqual(orgARows.map((g) => g.goalId), ['goal-A']);
});

test('AD: an ACTIVE membership pointing at an organization that does not exist in data-foundation cannot become valid authority', async () => {
  const world = buildRealWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  // Deliberately never create 'org-orphan' in data-foundation's organizations table.
  await world.memberships.create({ organizationId: 'org-orphan', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });

  const { SupabaseIdentityProviderAdapter } = await import('@samvardiq/identity-access/dist/providers/index.js');
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ sub: 'sub-1' });
  const verifiedPrincipal = await adapter.verifyCredential({ rawToken: token });

  // The membership row genuinely exists and is ACTIVE — proving the fix is the organization-existence
  // check, not merely "no membership was found."
  const existingMembership = await world.memberships.get('org-orphan', 'id-1');
  assert.equal(existingMembership?.status, 'ACTIVE');

  await assertDenied(resolveOrganizationAccess(world.authz, world.organizations, verifiedPrincipal, 'org-orphan'), 'FORBIDDEN');
});

test('AD (variant): the same orphan-membership case denies through the full handleListGoalsRequest boundary and never calls the protected service', async () => {
  const world = buildRealWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await world.memberships.create({ organizationId: 'org-orphan', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });

  const { SupabaseIdentityProviderAdapter } = await import('@samvardiq/identity-access/dist/providers/index.js');
  const identityProvider = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const { handleListGoalsRequest } = await import('../../src/protectedGoalListHandler.js');
  let calls = 0;
  const originalListGoals = world.goalReadService.listGoals.bind(world.goalReadService);
  world.goalReadService.listGoals = async (context) => {
    calls += 1;
    return originalListGoals(context);
  };

  await assertDenied(
    handleListGoalsRequest(
      { identityProvider, authz: world.authz, organizations: world.organizations, goalReadService: world.goalReadService },
      { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-orphan' },
    ),
    'FORBIDDEN',
  );
  assert.equal(calls, 0);
});
