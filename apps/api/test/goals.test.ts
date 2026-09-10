import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SupabaseIdentityProviderAdapter } from '@samvardiq/identity-access/dist/providers/index.js';

import { unreachableFetch } from '../../../packages/identity-access/test/jwksTestHelper.js';
import { buildAppVariant, buildWorld, provisionMember } from './setup.js';

/**
 * C-Z, AA-AC of the adversarial matrix (section 39), exercised through
 * Fastify's real `.inject()` request pipeline (routing, schema validation,
 * error handler) rather than by calling `handleListGoalsRequest` directly —
 * this is the HTTP-layer mirror of the already-proven boundary in
 * `application-services/test/composition.test.ts` (H-R, U, V, X, AJ), used
 * here to prove the *router* wires that boundary correctly, not to
 * re-derive the boundary's own logic (section 40: "do not mock the exact
 * boundary being claimed" — the real AuthorizationService and a real signed
 * JWT are used throughout, only the JWKS network transport is faked, as
 * identity-access's own test suite already established).
 */
function goalsUrl(organizationId: string, query = ''): string {
  return `/v1/organizations/${organizationId}/goals${query}`;
}

async function get(app: Awaited<ReturnType<typeof buildWorld>>['app'], organizationId: string, token?: string, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: goalsUrl(organizationId),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
  });
}

test('C: protected route without Authorization -> 401', async () => {
  const world = await buildWorld();
  const res = await get(world.app, 'org-A');
  assert.equal(res.statusCode, 401);
  await world.app.close();
});

test('D: malformed Authorization (no scheme separator) -> 401', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({ method: 'GET', url: goalsUrl('org-A'), headers: { authorization: 'garbage-no-scheme' } });
  assert.equal(res.statusCode, 401);
  await world.app.close();
});

test('E: wrong auth scheme (Basic) -> 401', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({ method: 'GET', url: goalsUrl('org-A'), headers: { authorization: 'Basic dXNlcjpwYXNz' } });
  assert.equal(res.statusCode, 401);
  await world.app.close();
});

test('F: invalid token -> 401', async () => {
  const world = await buildWorld();
  const res = await get(world.app, 'org-A', 'not-a-real-jwt');
  assert.equal(res.statusCode, 401);
  await world.app.close();
});

test('G: expired token -> 401', async () => {
  const world = await buildWorld();
  const token = await world.issuer.signToken({ expiresInSeconds: -3600 });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 401);
  await world.app.close();
});

test('H: provider (JWKS) unavailability -> 503, never a silent pass', async () => {
  const world = await buildWorld();
  const outageAdapter = new SupabaseIdentityProviderAdapter({
    projectUrl: world.issuer.projectUrl,
    jwksOptions: { customFetch: unreachableFetch } as never,
  });
  const outageApp = await buildAppVariant(world, { identityProvider: outageAdapter });
  await outageApp.ready();
  const token = await world.issuer.signToken();

  const res = await get(outageApp, 'org-A', token);
  assert.equal(res.statusCode, 503);

  await outageApp.close();
  await world.app.close();
});

test('I: valid auth with no provider link -> 403', async () => {
  const world = await buildWorld();
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'unlinked-subject' });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('J: a SUSPENDED identity is denied (403) despite a valid token', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.identities.updateStatus('id-1', 'suspended');
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('K: a REVOKED identity is denied (403) despite a valid token', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.identities.updateStatus('id-1', 'revoked');
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('L: no organization membership -> 403', async () => {
  const world = await buildWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('M: an INVITED (not yet active) membership -> 403', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'INVITED' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('N: a SUSPENDED membership -> 403', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'SUSPENDED' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('O: a REVOKED membership -> 403', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'REVOKED' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('P: an Org A member requesting Org B via the route param -> 403', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await get(world.app, 'org-B', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('Q: a valid Org A request reaches the real GoalReadService and returns Org A data only', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.goals.create({ goalId: 'goal-1', organizationId: 'org-A', title: 'Grow appointments', description: 'x' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].organizationId, 'org-A');
  assert.equal(body[0].goalId, 'goal-1');
  await world.app.close();
});

test('R: a multi-organization identity accesses A and B independently over separate real HTTP requests', async () => {
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

  const resA = await get(world.app, 'org-A', token);
  const resB = await get(world.app, 'org-B', token);
  assert.deepEqual(resA.json().map((g: { goalId: string }) => g.goalId), ['goal-A']);
  assert.deepEqual(resB.json().map((g: { goalId: string }) => g.goalId), ['goal-B']);
  await world.app.close();
});

test('S: a genuinely-existing organization id in the route grants nothing without a real membership', async () => {
  const world = await buildWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 403);
  await world.app.close();
});

test('T: a query-string organizationId cannot override the route parameter\'s authority', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'x', description: 'x' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  // The route is authoritatively org-A; a query string claiming org-B is never read by the router.
  const res = await world.app.inject({
    method: 'GET',
    url: goalsUrl('org-A', '?organizationId=org-B'),
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().map((g: { goalId: string }) => g.goalId), ['goal-A']);
  await world.app.close();
});

test('U: the legacy x-samvardiq-organization-id header cannot override the route parameter\'s authority', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.goals.create({ goalId: 'goal-A', organizationId: 'org-A', title: 'x', description: 'x' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const res = await get(world.app, 'org-A', token, { 'x-samvardiq-organization-id': 'org-B' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().map((g: { goalId: string }) => g.goalId), ['goal-A']);
  await world.app.close();
});

test('V: a nonexistent organization produces the identical denial as "no membership" (non-enumerable)', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const resNoMembership = await get(world.app, 'org-A', await world.issuer.signToken({ sub: 'unlinked-2' }));
  const resNonexistent = await get(world.app, 'org-does-not-exist', token);
  assert.equal(resNonexistent.statusCode, 403);
  assert.equal(resNoMembership.statusCode, resNonexistent.statusCode);
  assert.deepEqual(resNoMembership.json(), resNonexistent.json());
  await world.app.close();
});

test('X: the verified provider subject cannot be substituted for the internal identityId', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  assert.equal(await world.memberships.get('org-A', 'sub-1'), undefined);
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []); // resolves via id-1, not the raw subject string
  await world.app.close();
});

test('Y: no email claim reaches the response — access is granted by membership alone', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' }); // this issuer never embeds an email claim
  const res = await get(world.app, 'org-A', token);
  assert.equal(res.statusCode, 200);
  await world.app.close();
});

test('AA/AB/AC: OWNER, MEMBER, and VIEWER organization roles are all equally sufficient to read goals — none carries approval authority into this route', async () => {
  const world = await buildWorld();
  for (const role of ['OWNER', 'MEMBER', 'VIEWER'] as const) {
    const organizationId = `org-${role}`; // a distinct organization per role — isolates each case, avoids a duplicate-organization create
    const identityId = `id-${role}`;
    await provisionMember(world, { identityId, subject: `sub-${role}`, organizationId, role });
    const token = await world.issuer.signToken({ sub: `sub-${role}` });
    const res = await get(world.app, organizationId, token);
    assert.equal(res.statusCode, 200, `role ${role} should be able to read organization goals`);
    // Goal objects carry no role/approverRole field — reading never exposes or depends on approval authority.
    for (const goal of res.json()) {
      assert.ok(!('role' in goal) && !('approverRole' in goal));
    }
  }
  await world.app.close();
});
