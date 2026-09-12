import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthorizationService } from '../src/authorizationService.js';
import { InMemoryIdentityRepository } from '../src/identityRepository.js';
import { InMemoryMembershipRepository } from '../src/membershipRepository.js';
import { InMemoryIdentityProviderLinkRepository } from '../src/providerLinkRepository.js';
import type { MembershipStatus, VerifiedPrincipal } from '../src/types.js';

/**
 * E-K, N, O of the IDENTITY-W8 adversarial matrix (unit level — L, M, R,
 * S, T require real PostgreSQL RLS, see
 * test/integration/organizationDiscovery.test.ts).
 */

const PROVIDER = 'test';

function setup() {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const service = new AuthorizationService(identities, providerLinks, memberships);
  return { identities, providerLinks, memberships, service };
}

function principal(subject: string): VerifiedPrincipal {
  return { provider: PROVIDER, providerSubject: subject, verifiedAt: new Date().toISOString() };
}

async function provisionHuman(
  ctx: ReturnType<typeof setup>,
  opts: { identityId: string; subject: string; organizationId?: string; membershipStatus?: MembershipStatus; role?: 'OWNER' | 'MEMBER' | 'VIEWER' },
) {
  await ctx.identities.create({ identityId: opts.identityId, principalType: 'human', displayName: opts.identityId });
  await ctx.providerLinks.create({ identityId: opts.identityId, provider: PROVIDER, providerSubject: opts.subject });
  if (opts.organizationId) {
    await ctx.memberships.create({
      organizationId: opts.organizationId,
      identityId: opts.identityId,
      role: opts.role ?? 'MEMBER',
      status: opts.membershipStatus ?? 'ACTIVE',
    });
  }
}

test('E: a valid provider principal with no internal IdentityProviderLink gets an empty list, not an error', async () => {
  const ctx = setup();
  const result = await ctx.service.listEligibleOrganizations(principal('never-linked'));
  assert.deepEqual(result, []);
});

test('F: a SUSPENDED identity gets an empty list even though it has real ACTIVE memberships', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await ctx.identities.updateStatus('id-1', 'suspended');
  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  assert.deepEqual(result, []);
});

test('G: a REVOKED identity gets an empty list', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await ctx.identities.updateStatus('id-1', 'revoked');
  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  assert.deepEqual(result, []);
});

test('H: an ACTIVE identity sees only its own eligible ACTIVE memberships', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await ctx.memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });
  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  assert.deepEqual(
    result.sort((a, b) => a.organizationId.localeCompare(b.organizationId)),
    [
      { organizationId: 'org-A', role: 'OWNER' },
      { organizationId: 'org-B', role: 'VIEWER' },
    ],
  );
});

test('I: an INVITED membership is never selectable — excluded from discovery', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'INVITED' });
  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  assert.deepEqual(result, []);
});

test('J: a SUSPENDED membership is not selectable', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'SUSPENDED' });
  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  assert.deepEqual(result, []);
});

test('K: a REVOKED membership is not selectable', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'REVOKED' });
  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  assert.deepEqual(result, []);
});

test('H (variant): a mix of ACTIVE, INVITED, SUSPENDED, and REVOKED memberships returns only the ACTIVE one', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', membershipStatus: 'ACTIVE' });
  await ctx.memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'MEMBER', status: 'INVITED' });
  await ctx.memberships.create({ organizationId: 'org-C', identityId: 'id-1', role: 'MEMBER', status: 'SUSPENDED' });
  await ctx.memberships.create({ organizationId: 'org-D', identityId: 'id-1', role: 'MEMBER', status: 'REVOKED' });

  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  assert.deepEqual(result, [{ organizationId: 'org-A', role: 'MEMBER' }]);
});

test('N: provider subject cannot substitute for internal identityId in discovery results', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  // The result is keyed by real identityId internally (membership lookup uses identityId, never the raw subject) —
  // proven by the fact that a membership row keyed on the raw subject string does not exist and is never consulted.
  assert.equal(await ctx.memberships.get('org-A', 'sub-1'), undefined);
  assert.deepEqual(result, [{ organizationId: 'org-A', role: 'OWNER' }]);
});

test('O: no email claim is involved anywhere in discovery — VerifiedPrincipal carries no email field at all', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'MEMBER' });
  const p = principal('sub-1');
  assert.ok(!('email' in p));
  const result = await ctx.service.listEligibleOrganizations(p);
  assert.deepEqual(result, [{ organizationId: 'org-A', role: 'MEMBER' }]);
});

test('P: discovery never returns a TrustedOrganizationContext-shaped object — no organizationId-establishing fields beyond the plain list', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  const result = await ctx.service.listEligibleOrganizations(principal('sub-1'));
  for (const entry of result) {
    assert.deepEqual(Object.keys(entry).sort(), ['organizationId', 'role']);
    assert.ok(!('membershipId' in entry) && !('establishedAt' in entry) && !('approverRole' in entry) && !('principalType' in entry));
  }
});
