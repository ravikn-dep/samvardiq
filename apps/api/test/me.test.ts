import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWorld, provisionMember } from './setup.js';

/** HTTP-layer slice of the IDENTITY-W8 organization-discovery adversarial matrix (A-D, E, H, plus BA-BC error hygiene). */

test('A: unauthenticated GET /v1/me/organizations -> 401', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({ method: 'GET', url: '/v1/me/organizations' });
  assert.equal(res.statusCode, 401);
  await world.app.close();
});

test('B: an invalid token -> 401', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: 'Bearer not-a-real-jwt' } });
  assert.equal(res.statusCode, 401);
  await world.app.close();
});

test('C: an expired token -> 401', async () => {
  const world = await buildWorld();
  const token = await world.issuer.signToken({ expiresInSeconds: -3600 });
  const res = await world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 401);
  await world.app.close();
});

test('E: a valid token for an unprovisioned identity -> 200 with an empty array (never a distinguishable denial)', async () => {
  const world = await buildWorld();
  const token = await world.issuer.signToken({ sub: 'never-provisioned' });
  const res = await world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);
  await world.app.close();
});

test('F/G: a SUSPENDED or REVOKED identity gets the identical 200 empty-array response as an unprovisioned one', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-suspended', subject: 'sub-suspended', organizationId: 'org-A', role: 'OWNER' });
  await world.identities.updateStatus('id-suspended', 'suspended');
  await provisionMember(world, { identityId: 'id-revoked', subject: 'sub-revoked', organizationId: 'org-B', role: 'OWNER' });
  await world.identities.updateStatus('id-revoked', 'revoked');

  const tokenSuspended = await world.issuer.signToken({ sub: 'sub-suspended' });
  const tokenRevoked = await world.issuer.signToken({ sub: 'sub-revoked' });
  const tokenUnprovisioned = await world.issuer.signToken({ sub: 'never-provisioned' });

  const [resSuspended, resRevoked, resUnprovisioned] = await Promise.all([
    world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${tokenSuspended}` } }),
    world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${tokenRevoked}` } }),
    world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${tokenUnprovisioned}` } }),
  ]);
  for (const res of [resSuspended, resRevoked, resUnprovisioned]) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  }
  assert.deepEqual(resSuspended.json(), resRevoked.json());
  assert.deepEqual(resRevoked.json(), resUnprovisioned.json());
  await world.app.close();
});

test('H: a provisioned OWNER sees exactly their own organization, role, and display name — no extra fields', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const res = await world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), [{ organizationId: 'org-A', name: 'org-A', role: 'OWNER' }]);
  await world.app.close();
});

test('I/J/K: INVITED/SUSPENDED/REVOKED memberships are never selectable — excluded from the response', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'INVITED' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'MEMBER', status: 'SUSPENDED' });
  await world.organizations.create({ organizationId: 'org-C', organizationType: 'clinic', name: 'org-C' });
  await world.memberships.create({ organizationId: 'org-C', identityId: 'id-1', role: 'MEMBER', status: 'REVOKED' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const res = await world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);
  await world.app.close();
});

test('Z: a multi-org user can see both organizations for a subsequent selector/switch flow', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const res = await world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  const body = res.json().sort((a: { organizationId: string }, b: { organizationId: string }) => a.organizationId.localeCompare(b.organizationId));
  assert.deepEqual(body, [
    { organizationId: 'org-A', name: 'org-A', role: 'OWNER' },
    { organizationId: 'org-B', name: 'org-B', role: 'VIEWER' },
  ]);
  await world.app.close();
});

test('BA/BB/BC: a 401 response from this route never leaks the token, and an empty-list response never leaks internal identity/SQL details', async () => {
  const world = await buildWorld();
  const badToken = 'not-a-real-jwt-but-looks-plausible';
  const res401 = await world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${badToken}` } });
  assert.ok(!res401.body.includes(badToken));

  await provisionMember(world, { identityId: 'id-secret', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await world.identities.updateStatus('id-secret', 'suspended');
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res200 = await world.app.inject({ method: 'GET', url: '/v1/me/organizations', headers: { authorization: `Bearer ${token}` } });
  assert.ok(!res200.body.toLowerCase().includes('id-secret'));
  assert.ok(!res200.body.toLowerCase().includes('sub-1'));
  await world.app.close();
});
