import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { AuthorizationService } from '@samvardiq/identity-access';
import {
  PostgresIdentityRepository,
  PostgresIdentityProviderLinkRepository,
  PostgresMembershipAdministrationService,
  PostgresMembershipRepository,
} from '@samvardiq/identity-access/dist/postgres/index.js';
import { SupabaseIdentityProviderAdapter } from '@samvardiq/identity-access/dist/providers/index.js';
import { PostgresGoalRepository, PostgresOrganizationRepository } from '@samvardiq/data-foundation/dist/postgres/index.js';
import { GoalReadService } from '@samvardiq/application-services';

import { buildServer } from '../../src/server.js';
import { defaultTestConfig } from '../setup.js';
import { createTestIssuer, type TestIssuer } from '../../../../packages/identity-access/test/jwksTestHelper.js';
import { startHarness, type Harness } from '../../../../packages/application-services/test/integration/harness.js';

/**
 * The real-HTTP + real-PostgreSQL slice of the IDENTITY-W8 organization
 * discovery adversarial matrix (L, M — cross-identity isolation via real
 * RLS, reached through the full router).
 */

const PORT = 55616;
let harness: Harness;
let issuer: TestIssuer;
let app: Awaited<ReturnType<typeof buildServer>>;
let identities: PostgresIdentityRepository;
let providerLinks: PostgresIdentityProviderLinkRepository;
let memberships: PostgresMembershipRepository;
let organizations: PostgresOrganizationRepository;

before(async () => {
  harness = await startHarness(PORT);
  issuer = await createTestIssuer();

  const identityProvider = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  identities = new PostgresIdentityRepository(harness.identityApp.db);
  providerLinks = new PostgresIdentityProviderLinkRepository(harness.identityApp.db);
  memberships = new PostgresMembershipRepository(harness.identityApp.db);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  organizations = new PostgresOrganizationRepository(harness.dataFoundationApp.db);
  const goals = new PostgresGoalRepository(harness.dataFoundationApp.db);
  const goalReadService = new GoalReadService(goals);
  const membershipAdmin = new PostgresMembershipAdministrationService(harness.identityApp.db, identities);

  app = await buildServer({ identityProvider, authz, organizations, goalReadService, membershipAdmin }, defaultTestConfig());
  await app.ready();
});

beforeEach(async () => {
  await harness.truncateAll();
});

after(async () => {
  await app.close();
  await harness.stop();
});

async function seedMember(identityId: string, subject: string, organizationId: string, role: 'OWNER' | 'MEMBER' | 'VIEWER'): Promise<string> {
  if (!(await organizations.get(organizationId))) {
    await organizations.create({ organizationId, organizationType: 'clinic', name: organizationId });
  }
  await identities.create({ identityId, principalType: 'human', displayName: identityId });
  await providerLinks.create({ identityId, provider: 'supabase', providerSubject: subject });
  await memberships.create({ organizationId, identityId, role, status: 'ACTIVE' });
  return issuer.signToken({ sub: subject });
}

test('L: user A cannot discover user B\'s organizations over real HTTP + real RLS', async () => {
  const tokenA = await seedMember('id-a', 'sub-a', 'org-A', 'OWNER');
  const tokenB = await seedMember('id-b', 'sub-b', 'org-B', 'OWNER');

  const resA = await app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${tokenA}` } });
  const resB = await app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${tokenB}` } });

  assert.deepEqual(resA.json(), [{ organizationId: 'org-A', name: 'org-A', role: 'OWNER' }]);
  assert.deepEqual(resB.json(), [{ organizationId: 'org-B', name: 'org-B', role: 'OWNER' }]);
});

test('full flow: discover -> select -> the same real Fastify instance authorizes the selected organization\'s protected goals route', async () => {
  const token = await seedMember('id-1', 'sub-1', 'org-A', 'OWNER');

  const discovery = await app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${token}` } });
  assert.equal(discovery.statusCode, 200);
  const [selected] = discovery.json();
  assert.equal(selected.organizationId, 'org-A');

  const goalsRes = await app.inject({
    method: 'GET',
    url: `/v1/organizations/${selected.organizationId}/goals`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(goalsRes.statusCode, 200);
  assert.deepEqual(goalsRes.json(), []);
});

test('M: a multi-organization identity discovers both real organizations over HTTP, isolated from a third identity in one of them', async () => {
  const token1 = await seedMember('id-1', 'sub-1', 'org-A', 'OWNER');
  await organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });
  await seedMember('id-2', 'sub-2', 'org-B', 'MEMBER');

  const res = await app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${token1}` } });
  const body = res.json().sort((a: { organizationId: string }, b: { organizationId: string }) => a.organizationId.localeCompare(b.organizationId));
  assert.deepEqual(body, [
    { organizationId: 'org-A', name: 'org-A', role: 'OWNER' },
    { organizationId: 'org-B', name: 'org-B', role: 'VIEWER' },
  ]);
});
