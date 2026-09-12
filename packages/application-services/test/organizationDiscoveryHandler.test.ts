import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleListMyOrganizationsRequest } from '../src/organizationDiscoveryHandler.js';
import { buildWorld, provisionMember } from './setup.js';

/**
 * A-D of the IDENTITY-W8 adversarial matrix at the request-boundary level
 * (E-K, N, O, P are proven in identity-access's own unit/integration
 * suites — this file proves the HANDLER wires them correctly, including
 * the orphan-organization skip and the credential-failure error contract).
 */

test('A: unauthenticated (no Authorization header) is denied — never returns an empty-but-successful list', async () => {
  const world = await buildWorld();
  await assert.rejects(handleListMyOrganizationsRequest(world.deps, { authorizationHeader: undefined }));
});

test('B: an invalid token is denied', async () => {
  const world = await buildWorld();
  await assert.rejects(handleListMyOrganizationsRequest(world.deps, { authorizationHeader: 'Bearer not-a-real-jwt' }));
});

test('C: an expired token is denied', async () => {
  const world = await buildWorld();
  const token = await world.issuer.signToken({ expiresInSeconds: -3600 });
  await assert.rejects(handleListMyOrganizationsRequest(world.deps, { authorizationHeader: `Bearer ${token}` }));
});

test('D: provider (JWKS) unavailability fails closed', async () => {
  const { SupabaseIdentityProviderAdapter } = await import('@samvardiq/identity-access/dist/providers/index.js');
  const { unreachableFetch } = await import('../../identity-access/test/jwksTestHelper.js');
  const world = await buildWorld();
  const outageAdapter = new SupabaseIdentityProviderAdapter({
    projectUrl: world.issuer.projectUrl,
    jwksOptions: { customFetch: unreachableFetch } as never,
  });
  const token = await world.issuer.signToken();
  await assert.rejects(
    handleListMyOrganizationsRequest({ ...world.deps, identityProvider: outageAdapter }, { authorizationHeader: `Bearer ${token}` }),
  );
});

test('E: a valid token for an unprovisioned identity returns an empty list, not an error', async () => {
  const world = await buildWorld();
  const token = await world.issuer.signToken({ sub: 'never-provisioned' });
  const result = await handleListMyOrganizationsRequest(world.deps, { authorizationHeader: `Bearer ${token}` });
  assert.deepEqual(result, []);
});

test('H: a provisioned identity sees its own eligible organizations with real display names, role, and organizationId only', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const result = await handleListMyOrganizationsRequest(world.deps, { authorizationHeader: `Bearer ${token}` });
  assert.deepEqual(result, [{ organizationId: 'org-A', name: 'org-A', role: 'OWNER' }]);
  for (const entry of result) {
    assert.deepEqual(Object.keys(entry).sort(), ['name', 'organizationId', 'role']);
  }
});

test('an orphan membership (organization no longer exists in data-foundation) is silently skipped, never surfaced as a broken entry', async () => {
  const world = await buildWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  // Membership exists, but the organization itself was never created in data-foundation.
  await world.memberships.create({ organizationId: 'org-orphan', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const result = await handleListMyOrganizationsRequest(world.deps, { authorizationHeader: `Bearer ${token}` });
  assert.deepEqual(result, []);
});

test('a multi-organization identity sees both organizations independently, never bleeding one org\'s data into another\'s entry', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  await world.memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const result = await handleListMyOrganizationsRequest(world.deps, { authorizationHeader: `Bearer ${token}` });
  assert.deepEqual(
    result.sort((a, b) => a.organizationId.localeCompare(b.organizationId)),
    [
      { organizationId: 'org-A', name: 'org-A', role: 'OWNER' },
      { organizationId: 'org-B', name: 'org-B', role: 'VIEWER' },
    ],
  );
});
