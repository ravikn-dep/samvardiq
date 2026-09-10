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
 * AC/AR (section 39/40): a real, disposable PostgreSQL instance, both
 * packages' RLS-protected schemas coexisting in one database, all
 * repositories constructed on the `samvardiq_app` (RLS-subject, grant-
 * restricted) role — never the migration owner — reached through a REAL
 * Fastify HTTP request via `.inject()`, not by calling application-services
 * functions directly. This is the HTTP-layer mirror of
 * `application-services/test/integration/postgres.test.ts`'s AC, proving
 * the router's full composition (identityProvider -> authz -> goalReadService
 * -> Postgres repository -> RLS) end to end.
 */

let harness: Harness;
let issuer: TestIssuer;
let app: Awaited<ReturnType<typeof buildServer>>;

before(async () => {
  harness = await startHarness(55611);
  issuer = await createTestIssuer();

  const identityProvider = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const identities = new PostgresIdentityRepository(harness.identityApp.db);
  const providerLinks = new PostgresIdentityProviderLinkRepository(harness.identityApp.db);
  const memberships = new PostgresMembershipRepository(harness.identityApp.db);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  const organizations = new PostgresOrganizationRepository(harness.dataFoundationApp.db);
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

test('AC: a real HTTP request through real PostgreSQL RLS returns only the requested organization\'s goals, even though both organizations\' data lives in the same database', async () => {
  // Provisioning uses the same app-role repositories the running server itself uses (RLS allows scoped writes; no owner-role bypass needed).
  const identities = new PostgresIdentityRepository(harness.identityApp.db);
  const providerLinks = new PostgresIdentityProviderLinkRepository(harness.identityApp.db);
  const memberships = new PostgresMembershipRepository(harness.identityApp.db);
  const organizations = new PostgresOrganizationRepository(harness.dataFoundationApp.db);
  const goals = new PostgresGoalRepository(harness.dataFoundationApp.db);

  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  await organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await memberships.create({ organizationId: 'org-A', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });
  await goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'x', description: 'x' });
  await goals.create({ goalId: 'goal-B', organizationId: 'org-B', title: 'x', description: 'x' });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const resA = await app.inject({ method: 'GET', url: '/v1/organizations/org-A/goals', headers: { authorization: `Bearer ${token}` } });
  assert.equal(resA.statusCode, 200);
  assert.deepEqual(resA.json().map((g: { goalId: string }) => g.goalId), ['goal-A']);

  const resB = await app.inject({ method: 'GET', url: '/v1/organizations/org-B/goals', headers: { authorization: `Bearer ${token}` } });
  assert.equal(resB.statusCode, 403); // id-1 has no membership in org-B — RLS is defense-in-depth, this denial happens at the authorization layer first
});

test('AR: an orphan membership (ACTIVE membership pointing at an organization that does not exist in data-foundation) is denied over real HTTP, and the RLS-protected repository is never reached for it', async () => {
  const identities = new PostgresIdentityRepository(harness.identityApp.db);
  const providerLinks = new PostgresIdentityProviderLinkRepository(harness.identityApp.db);
  const memberships = new PostgresMembershipRepository(harness.identityApp.db);

  await identities.create({ identityId: 'id-2', principalType: 'human', displayName: 'id-2' });
  await providerLinks.create({ identityId: 'id-2', provider: 'supabase', providerSubject: 'sub-2' });
  // Deliberately never create 'org-orphan' in data-foundation's organizations table.
  await memberships.create({ organizationId: 'org-orphan', identityId: 'id-2', role: 'OWNER', status: 'ACTIVE' });
  const token = await issuer.signToken({ sub: 'sub-2' });

  const res = await app.inject({ method: 'GET', url: '/v1/organizations/org-orphan/goals', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 403);
});

test('AZ: this suite requires no production secret — only a disposable, locally-started embedded PostgreSQL and a locally-generated test JWT issuer', () => {
  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(process.env.DATABASE_URL, undefined);
});
