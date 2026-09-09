import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyError } from '../src/errors.js';
import { handleListGoalsRequest } from '../src/protectedGoalListHandler.js';
import { buildWorld, provisionMember } from './setup.js';

/**
 * AF / AI: the classified, client-facing error is always one of a small
 * set of fixed generic strings (see errors.ts) — never the original
 * error's own message, which is where a provider subject, internal
 * identityId, SQL/RLS detail, or (via the original credential-parsing
 * error) a token fragment could otherwise leak.
 */

test('AF: classified errors never contain provider subject, internal identityId, org id, or the original message text', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'sensitive-internal-id-1', subject: 'sensitive-provider-subject-1', organizationId: 'org-A', membershipStatus: 'SUSPENDED' });
  const token = await world.issuer.signToken({ sub: 'sensitive-provider-subject-1' });

  const classified = await handleListGoalsRequest(world.deps, {
    authorizationHeader: `Bearer ${token}`,
    requestedOrganizationId: 'org-A',
  }).catch((error: unknown) => classifyError(error));

  const serialized = JSON.stringify(classified);
  assert.ok(!serialized.includes('sensitive-internal-id-1'));
  assert.ok(!serialized.includes('sensitive-provider-subject-1'));
  assert.deepEqual(classified, { errorClass: 'FORBIDDEN', httpStatus: 403, message: 'Access denied.' });
});

test('AF (variant): an unknown/orphan organization produces the identical generic response as "no membership" — no enumeration signal', async () => {
  const world = await buildWorld();
  await world.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await world.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const orphanOrgResult = await handleListGoalsRequest(world.deps, {
    authorizationHeader: `Bearer ${token}`,
    requestedOrganizationId: 'org-does-not-exist',
  }).catch((error: unknown) => classifyError(error));

  await world.organizations.create({ organizationId: 'org-real-no-membership', organizationType: 'clinic', name: 'x' });
  const noMembershipResult = await handleListGoalsRequest(world.deps, {
    authorizationHeader: `Bearer ${token}`,
    requestedOrganizationId: 'org-real-no-membership',
  }).catch((error: unknown) => classifyError(error));

  assert.deepEqual(orphanOrgResult, noMembershipResult);
});

test('AI: the raw token never appears in a classified error, even for a malformed-credential rejection', async () => {
  const world = await buildWorld();
  const secretLookingToken = await world.issuer.signToken({ expiresInSeconds: -1 });

  const classified = await handleListGoalsRequest(world.deps, {
    authorizationHeader: `Bearer ${secretLookingToken}`,
    requestedOrganizationId: 'org-A',
  }).catch((error: unknown) => classifyError(error));

  assert.ok(!JSON.stringify(classified).includes(secretLookingToken));
});
