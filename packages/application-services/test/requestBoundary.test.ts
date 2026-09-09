import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyError } from '../src/errors.js';
import { handleListGoalsRequest } from '../src/protectedGoalListHandler.js';
import { unreachableFetch } from '../../identity-access/test/jwksTestHelper.js';
import { assertDenied, buildWorld, provisionMember } from './setup.js';

/**
 * A-G, W: the credential-transport / authentication half of the
 * adversarial matrix (section 30). Every case asserts the specific
 * UNAUTHENTICATED (or, for G, AUTH_PROVIDER_UNAVAILABLE) classification —
 * not merely "the promise rejected" — AND (via a call-counting spy on
 * `listGoals`) that the protected application service was never invoked
 * (W), proving the request boundary fails closed before any business
 * logic runs.
 */
async function countedHandler(world: Awaited<ReturnType<typeof buildWorld>>) {
  let calls = 0;
  const originalListGoals = world.goalReadService.listGoals.bind(world.goalReadService);
  world.goalReadService.listGoals = async (context) => {
    calls += 1;
    return originalListGoals(context);
  };
  return { getCalls: () => calls };
}

test('A: no Authorization header fails closed and never invokes the protected service (401-class)', async () => {
  const world = await buildWorld();
  const spy = await countedHandler(world);

  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: undefined, requestedOrganizationId: 'org-A' }),
    'UNAUTHENTICATED',
  );
  assert.equal(spy.getCalls(), 0);
});

test('B: a malformed Authorization header (no scheme separator) is denied', async () => {
  const world = await buildWorld();
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: 'garbage-no-scheme', requestedOrganizationId: 'org-A' }),
    'UNAUTHENTICATED',
  );
});

test('C: an unsupported auth scheme (Basic) is denied', async () => {
  const world = await buildWorld();
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: 'Basic dXNlcjpwYXNz', requestedOrganizationId: 'org-A' }),
    'UNAUTHENTICATED',
  );
});

test('D: an empty Bearer token is denied', async () => {
  const world = await buildWorld();
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: 'Bearer ', requestedOrganizationId: 'org-A' }),
    'UNAUTHENTICATED',
  );
});

test('D (variant): multiple ambiguous Authorization header values are denied', async () => {
  const world = await buildWorld();
  const token = await world.issuer.signToken();
  await assertDenied(
    handleListGoalsRequest(world.deps, {
      authorizationHeader: [`Bearer ${token}`, `Bearer ${token}`],
      requestedOrganizationId: 'org-A',
    }),
    'UNAUTHENTICATED',
  );
});

test('E: a cryptographically invalid token is denied', async () => {
  const world = await buildWorld();
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: 'Bearer not-a-real-jwt', requestedOrganizationId: 'org-A' }),
    'UNAUTHENTICATED',
  );
});

test('F: an expired token is denied', async () => {
  const world = await buildWorld();
  const token = await world.issuer.signToken({ expiresInSeconds: -3600 });
  await assertDenied(
    handleListGoalsRequest(world.deps, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }),
    'UNAUTHENTICATED',
  );
});

test('G: provider (JWKS) unavailability fails closed, never falls back to trusting the token', async () => {
  const { SupabaseIdentityProviderAdapter } = await import('@samvardiq/identity-access/dist/providers/index.js');
  const world = await buildWorld();
  const spy = await countedHandler(world);
  const outageAdapter = new SupabaseIdentityProviderAdapter({
    projectUrl: world.issuer.projectUrl,
    jwksOptions: { customFetch: unreachableFetch } as never,
  });
  const token = await world.issuer.signToken();

  await assertDenied(
    handleListGoalsRequest(
      { ...world.deps, identityProvider: outageAdapter },
      { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' },
    ),
    'AUTH_PROVIDER_UNAVAILABLE',
  );
  assert.equal(spy.getCalls(), 0);
});

test('G (variant): the exact classified response for provider unavailability is 503, never a silent pass', async () => {
  const { SupabaseIdentityProviderAdapter } = await import('@samvardiq/identity-access/dist/providers/index.js');
  const world = await buildWorld();
  const outageAdapter = new SupabaseIdentityProviderAdapter({
    projectUrl: world.issuer.projectUrl,
    jwksOptions: { customFetch: unreachableFetch } as never,
  });
  const token = await world.issuer.signToken();

  const classified = await handleListGoalsRequest(
    { ...world.deps, identityProvider: outageAdapter },
    { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' },
  ).catch((error: unknown) => classifyError(error));

  assert.deepEqual(classified, {
    errorClass: 'AUTH_PROVIDER_UNAVAILABLE',
    httpStatus: 503,
    message: 'Authentication service is temporarily unavailable.',
  });
});

test('W: the protected service is never invoked for any authentication failure (aggregate check)', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const spy = await countedHandler(world);

  const badInputs: Array<{ authorizationHeader: string | undefined; requestedOrganizationId: string }> = [
    { authorizationHeader: undefined, requestedOrganizationId: 'org-A' },
    { authorizationHeader: 'Bearer', requestedOrganizationId: 'org-A' },
    { authorizationHeader: 'Bearer garbage', requestedOrganizationId: 'org-A' },
    { authorizationHeader: 'Token whatever', requestedOrganizationId: 'org-A' },
  ];

  for (const input of badInputs) {
    await assertDenied(handleListGoalsRequest(world.deps, input), 'UNAUTHENTICATED');
  }
  assert.equal(spy.getCalls(), 0, 'no authentication failure may reach the protected application service');
});
