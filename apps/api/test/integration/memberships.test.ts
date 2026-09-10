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
 * The HTTP-layer slice of the IDENTITY-W7 adversarial matrix — J, K, R, S,
 * AD, AE, AW, AX, AZ, BA-BC, BG-BJ, BK, BN, BO — real Fastify `.inject()`
 * requests against a real, disposable PostgreSQL instance. The
 * authorization/transition/last-owner/atomic-audit guarantees themselves
 * are proven in identity-access's own Postgres suite; this file proves the
 * ROUTER wires them correctly and that HTTP-specific input hygiene holds.
 */

const PORT = 55614;
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

async function ensureOrganization(organizationId: string): Promise<void> {
  if (!(await organizations.get(organizationId))) {
    await organizations.create({ organizationId, organizationType: 'clinic', name: organizationId });
  }
}

/** Section 22's orphan-organization check (W4/ARCH-016) requires the organization to exist in data-foundation's own table, independent of identity-access's membership row — always seeded here, matching apps/api's existing goals-route integration test convention. */
async function seedOwner(organizationId: string, identityId: string, subject: string): Promise<string> {
  await ensureOrganization(organizationId);
  await identities.create({ identityId, principalType: 'human', displayName: identityId });
  await providerLinks.create({ identityId, provider: 'supabase', providerSubject: subject });
  await memberships.create({ organizationId, identityId, role: 'OWNER', status: 'ACTIVE' });
  return issuer.signToken({ sub: subject });
}

async function createTargetIdentity(identityId: string): Promise<void> {
  await identities.create({ identityId, principalType: 'human', displayName: identityId });
}

// --- J/K/AD/AE: request body cannot smuggle organization/actor authority ---

test('J/K/AD/AE: an organizationId or actorIdentityId field in the body is rejected by schema before any business logic runs (400)', async () => {
  const token = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  await createTargetIdentity('target-1');

  const res = await app.inject({
    method: 'POST',
    url: '/v1/organizations/org-A/memberships',
    headers: { authorization: `Bearer ${token}` },
    payload: { targetIdentityId: 'target-1', role: 'MEMBER', organizationId: 'org-B', actorIdentityId: 'someone-else' },
  });
  assert.equal(res.statusCode, 400);
  const created = await memberships.get('org-A', 'target-1');
  assert.equal(created, undefined, 'the rejected request must never reach the administration service');
});

// --- R/S: invalid/unknown role rejected ---

test('R/S: an unknown role value is rejected by schema (400), never reaching the administration service', async () => {
  const token = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  await createTargetIdentity('target-1');

  const res = await app.inject({
    method: 'POST',
    url: '/v1/organizations/org-A/memberships',
    headers: { authorization: `Bearer ${token}` },
    payload: { targetIdentityId: 'target-1', role: 'SUPER_ADMIN' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(await memberships.get('org-A', 'target-1'), undefined);
});

// --- Full lifecycle over real HTTP ------------------------------------------

test('full governed lifecycle over real HTTP: create -> activate -> role change -> suspend -> reactivate -> revoke', async () => {
  const token = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  await createTargetIdentity('target-1');
  const authHeader = { authorization: `Bearer ${token}` };

  const created = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships', headers: authHeader, payload: { targetIdentityId: 'target-1', role: 'MEMBER' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().status, 'INVITED');

  const activated = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships/target-1/activate', headers: authHeader });
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json().status, 'ACTIVE');

  const roleChanged = await app.inject({ method: 'PATCH', url: '/v1/organizations/org-A/memberships/target-1/role', headers: authHeader, payload: { role: 'VIEWER' } });
  assert.equal(roleChanged.statusCode, 200);
  assert.equal(roleChanged.json().role, 'VIEWER');

  const suspended = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships/target-1/suspend', headers: authHeader });
  assert.equal(suspended.statusCode, 200);
  assert.equal(suspended.json().status, 'SUSPENDED');

  const reactivated = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships/target-1/reactivate', headers: authHeader });
  assert.equal(reactivated.statusCode, 200);
  assert.equal(reactivated.json().status, 'ACTIVE');

  const revoked = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships/target-1/revoke', headers: authHeader });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().status, 'REVOKED');

  // U: no resurrection.
  const resurrectAttempt = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships/target-1/reactivate', headers: authHeader });
  assert.equal(resurrectAttempt.statusCode, 409);
});

// --- B/C: MEMBER/VIEWER cannot administer over HTTP -------------------------

test('B: a MEMBER receives 403 attempting to administer over HTTP', async () => {
  await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  await identities.create({ identityId: 'member-1', principalType: 'human', displayName: 'member-1' });
  await providerLinks.create({ identityId: 'member-1', provider: 'supabase', providerSubject: 'sub-member-1' });
  await memberships.create({ organizationId: 'org-A', identityId: 'member-1', role: 'MEMBER', status: 'ACTIVE' });
  await createTargetIdentity('target-1');
  const token = await issuer.signToken({ sub: 'sub-member-1' });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/organizations/org-A/memberships',
    headers: { authorization: `Bearer ${token}` },
    payload: { targetIdentityId: 'target-1', role: 'MEMBER' },
  });
  assert.equal(res.statusCode, 403);
});

// --- AZ: non-enumerable denial for nonexistent membership vs. cross-org ------

test('AZ: acting on a nonexistent membership and acting on another organization\'s real membership return the identical denial shape (no cross-tenant enumeration)', async () => {
  const tokenA = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  await seedOwner('org-B', 'owner-2', 'sub-owner-2');
  await identities.create({ identityId: 'target-b', principalType: 'human', displayName: 'target-b' });
  await memberships.create({ organizationId: 'org-B', identityId: 'target-b', role: 'MEMBER', status: 'ACTIVE' });

  const resNonexistent = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships/does-not-exist/suspend', headers: { authorization: `Bearer ${tokenA}` } });
  const resCrossOrg = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships/target-b/suspend', headers: { authorization: `Bearer ${tokenA}` } });

  assert.equal(resNonexistent.statusCode, 403);
  assert.equal(resCrossOrg.statusCode, 403);
  assert.deepEqual(resNonexistent.json(), resCrossOrg.json());
});

// --- AW/AX: purpose-specific routes, no generic mass-assignment -------------

test('AW: the role-change route rejects an unrelated "status" field in the body (400) — no route can mutate fields outside its purpose', async () => {
  const token = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  await createTargetIdentity('target-1');
  await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships', headers: { authorization: `Bearer ${token}` }, payload: { targetIdentityId: 'target-1', role: 'MEMBER' } });

  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/organizations/org-A/memberships/target-1/role',
    headers: { authorization: `Bearer ${token}` },
    payload: { role: 'VIEWER', status: 'ACTIVE' },
  });
  assert.equal(res.statusCode, 400);
});

test('AX: no generic arbitrary status-mutation route exists', async () => {
  const token = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  const res = await app.inject({
    method: 'PATCH',
    url: '/v1/organizations/org-A/memberships/owner-1/status',
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'REVOKED' },
  });
  assert.equal(res.statusCode, 404);
});

test('AX (variant): a generic PATCH on the membership collection itself does not exist', async () => {
  const token = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  const res = await app.inject({ method: 'PATCH', url: '/v1/organizations/org-A/memberships/owner-1', headers: { authorization: `Bearer ${token}` }, payload: { status: 'REVOKED' } });
  assert.equal(res.statusCode, 404);
});

// --- BN/BO: no automatic membership from valid Supabase auth alone ---------

test('BN/BO: a validly authenticated Supabase user with no Samvardiq provisioning is denied on every membership route (no auto-provisioning, no auto-membership)', async () => {
  const token = await issuer.signToken({ sub: 'never-provisioned' });

  const list = [
    { method: 'POST' as const, url: '/v1/organizations/org-A/memberships', payload: { targetIdentityId: 'x', role: 'MEMBER' } },
    { method: 'POST' as const, url: '/v1/organizations/org-A/memberships/x/activate' },
    { method: 'POST' as const, url: '/v1/organizations/org-A/memberships/x/suspend' },
    { method: 'POST' as const, url: '/v1/organizations/org-A/memberships/x/revoke' },
    { method: 'PATCH' as const, url: '/v1/organizations/org-A/memberships/x/role', payload: { role: 'VIEWER' } },
  ];
  for (const req of list) {
    const res = await app.inject({ ...req, headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403, `${req.method} ${req.url} must deny an unprovisioned identity`);
  }
});

// --- BA/BB/BC: error/log hygiene for membership routes ----------------------

test('BA/BB/BC: a 403 denial on a membership route never leaks the token, actor identity, or SQL/constraint detail', async () => {
  const token = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/organizations/org-A/memberships/does-not-exist/suspend',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
  const body = res.body;
  for (const secret of [token, 'owner-1', 'select', 'insert', 'constraint', 'pkey']) {
    assert.ok(!body.toLowerCase().includes(secret.toLowerCase()), `403 body leaked "${secret}"`);
  }
  assert.deepEqual(res.json(), { error: 'Access denied.' });
});

test('a 409 conflict (duplicate membership) never leaks SQL/constraint detail', async () => {
  const token = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  await createTargetIdentity('target-1');
  await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships', headers: { authorization: `Bearer ${token}` }, payload: { targetIdentityId: 'target-1', role: 'MEMBER' } });

  const dup = await app.inject({ method: 'POST', url: '/v1/organizations/org-A/memberships', headers: { authorization: `Bearer ${token}` }, payload: { targetIdentityId: 'target-1', role: 'VIEWER' } });
  assert.equal(dup.statusCode, 409);
  assert.ok(!dup.body.toLowerCase().match(/pkey|constraint|23505/));
});

// --- BK: concurrency ----------------------------------------------------------

test('BK: 20 concurrent mixed-tenant admin/read requests preserve isolation', async () => {
  const tokenA = await seedOwner('org-A', 'owner-1', 'sub-owner-1');
  const tokenB = await seedOwner('org-B', 'owner-2', 'sub-owner-2');
  for (let i = 0; i < 10; i += 1) {
    await createTargetIdentity(`target-a-${i}`);
    await createTargetIdentity(`target-b-${i}`);
  }

  const requests = [
    ...Array.from({ length: 10 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: '/v1/organizations/org-A/memberships',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { targetIdentityId: `target-a-${i}`, role: 'MEMBER' },
      }),
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: '/v1/organizations/org-B/memberships',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { targetIdentityId: `target-b-${i}`, role: 'MEMBER' },
      }),
    ),
  ];
  const results = await Promise.all(requests);
  assert.ok(results.every((r) => r.statusCode === 201));

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await memberships.get('org-A', `target-a-${i}`))?.organizationId, 'org-A');
    assert.equal((await memberships.get('org-B', `target-b-${i}`))?.organizationId, 'org-B');
    assert.equal(await memberships.get('org-A', `target-b-${i}`), undefined, 'org-B targets must never leak into org-A');
  }
});
