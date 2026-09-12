import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthorizationService } from '../src/authorizationService.js';
import {
  InactiveIdentityError,
  MembershipNotActiveError,
  MembershipNotFoundError,
  ProviderIdentityNotLinkedError,
} from '../src/errors.js';
import { InMemoryIdentityRepository } from '../src/identityRepository.js';
import { InMemoryMembershipRepository } from '../src/membershipRepository.js';
import { InMemoryIdentityProviderLinkRepository } from '../src/providerLinkRepository.js';
import type { MembershipStatus, VerifiedPrincipal } from '../src/types.js';

const PROVIDER = 'test';
const ORG_A = 'org-A';
const ORG_B = 'org-B';

function setup() {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const service = new AuthorizationService(identities, providerLinks, memberships);
  return { identities, providerLinks, memberships, service };
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

function principal(subject: string): VerifiedPrincipal {
  return { provider: PROVIDER, providerSubject: subject, verifiedAt: new Date().toISOString() };
}

// A — valid HUMAN + ACTIVE identity + ACTIVE membership -> trusted context
test('A: valid human identity with active membership resolves a trusted context', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A, role: 'OWNER' });

  const trusted = await ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A });

  assert.equal(trusted.identityId, 'id-1');
  assert.equal(trusted.organizationId, ORG_A);
  assert.equal(trusted.role, 'OWNER');
  assert.equal(trusted.principalType, 'human');
  assert.equal(trusted.membershipId, `${ORG_A}::id-1`);
  assert.ok(Object.isFrozen(trusted));
});

// B — unknown provider subject -> denied
test('B: unknown provider subject is denied', async () => {
  const ctx = setup();
  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('ghost-subject'), requestedOrganizationId: ORG_A }),
    ProviderIdentityNotLinkedError,
  );
});

// C — inactive identity -> denied
test('C: an inactive identity is denied even with a valid active membership', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A });
  await ctx.identities.updateStatus('id-1', 'suspended');

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A }),
    InactiveIdentityError,
  );
});

// D — no membership -> denied
test('D: an identity with no membership row is denied', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1' }); // no organizationId -> no membership created

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A }),
    MembershipNotFoundError,
  );
});

// E — INVITED membership -> denied
test('E: an INVITED membership is denied', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A, membershipStatus: 'INVITED' });

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A }),
    MembershipNotActiveError,
  );
});

// F — SUSPENDED membership -> denied
test('F: a SUSPENDED membership is denied', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A, membershipStatus: 'SUSPENDED' });

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A }),
    MembershipNotActiveError,
  );
});

// G — REVOKED membership -> denied
test('G: a REVOKED membership is denied', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A, membershipStatus: 'REVOKED' });

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A }),
    MembershipNotActiveError,
  );
});

// H — user in Org A requests Org B without membership -> denied
test('H: a member of organization A is denied when requesting organization B without membership there', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A });

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_B }),
    MembershipNotFoundError,
  );
});

// I & J — multi-organization: context per org is isolated, and "switching" is just a new resolution
test('I & J: a user belonging to both A and B resolves an isolated context per organization', async () => {
  const ctx = setup();
  await ctx.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await ctx.providerLinks.create({ identityId: 'id-1', provider: PROVIDER, providerSubject: 'sub-1' });
  await ctx.memberships.create({ organizationId: ORG_A, identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });
  await ctx.memberships.create({ organizationId: ORG_B, identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });

  const contextA = await ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A });
  assert.equal(contextA.organizationId, ORG_A);
  assert.equal(contextA.role, 'OWNER');

  // "Switching" (J) is nothing more than a second, independent resolution for a different org.
  const contextB = await ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_B });
  assert.equal(contextB.organizationId, ORG_B);
  assert.equal(contextB.role, 'VIEWER');

  // Neither context carries any trace of the other organization.
  assert.notEqual(contextA.organizationId, contextB.organizationId);
  assert.notEqual(contextA.role, contextB.role);
});

// K — client-supplied org ID cannot create trusted context without membership
test('K: a client-supplied organizationId alone cannot establish trusted context without a real membership row', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1' }); // valid identity, zero memberships anywhere

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-attacker-claims' }),
    MembershipNotFoundError,
  );
});

// L — provider subject cannot be used as internal identityId to bypass lookup
test('L: a provider subject string cannot be substituted for an internal identityId', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A });

  // An attacker who only knows the provider subject (not the internal identityId)
  // must go through the real provider-link lookup — using the raw subject value
  // as if it were already an internal identityId must not resolve anything.
  const membershipUsingSubjectAsIdentityId = await ctx.memberships.get(ORG_A, 'sub-1');
  assert.equal(membershipUsingSubjectAsIdentityId, undefined, 'the provider subject must not double as an identityId');

  // The only correct path resolves successfully.
  const trusted = await ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A });
  assert.equal(trusted.identityId, 'id-1');
});

// M — duplicate provider link rejected
test('M: a duplicate (provider, providerSubject) link is rejected', async () => {
  const ctx = setup();
  await ctx.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await ctx.identities.create({ identityId: 'id-2', principalType: 'human', displayName: 'id-2' });
  await ctx.providerLinks.create({ identityId: 'id-1', provider: PROVIDER, providerSubject: 'sub-1' });

  await assert.rejects(
    ctx.providerLinks.create({ identityId: 'id-2', provider: PROVIDER, providerSubject: 'sub-1' }),
  );
});

// N — cross-org membership FK manipulation rejected (identity referential integrity)
test('N: a membership referencing an identity that does not exist is rejected', async () => {
  const ctx = setup();
  await assert.rejects(
    ctx.memberships.create({ organizationId: ORG_A, identityId: 'id-does-not-exist', role: 'MEMBER', status: 'ACTIVE' }),
  );
});

// O — malformed/invalid principal fails closed
test('O: a malformed principal (empty subject) fails closed rather than matching anything', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A });

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: { provider: PROVIDER, providerSubject: '', verifiedAt: new Date().toISOString() }, requestedOrganizationId: ORG_A }),
    ProviderIdentityNotLinkedError,
  );
});

// P — SERVICE principal cannot be treated as HUMAN
test('P: a service principal resolves with principalType "service", never "human"', async () => {
  const ctx = setup();
  await ctx.identities.create({ identityId: 'svc-1', principalType: 'service', displayName: 'connector' });
  await ctx.providerLinks.create({ identityId: 'svc-1', provider: PROVIDER, providerSubject: 'svc-sub-1' });
  await ctx.memberships.create({ organizationId: ORG_A, identityId: 'svc-1', role: 'MEMBER', status: 'ACTIVE' });

  const trusted = await ctx.service.resolveTrustedContext({ principal: principal('svc-sub-1'), requestedOrganizationId: ORG_A });
  assert.equal(trusted.principalType, 'service');
  assert.notEqual(trusted.principalType, 'human');
});

// Q — AI/service identity cannot become human approver through a mutable kind flag
test('Q: a service identity never carries approverRole, even if the membership row has one set', async () => {
  const ctx = setup();
  await ctx.identities.create({ identityId: 'svc-1', principalType: 'service', displayName: 'connector' });
  await ctx.providerLinks.create({ identityId: 'svc-1', provider: PROVIDER, providerSubject: 'svc-sub-1' });
  // Deliberately misconfigured membership: approverRole set on a service principal.
  await ctx.memberships.create({ organizationId: ORG_A, identityId: 'svc-1', role: 'OWNER', approverRole: 'founder', status: 'ACTIVE' });

  const trusted = await ctx.service.resolveTrustedContext({ principal: principal('svc-sub-1'), requestedOrganizationId: ORG_A });
  assert.equal(trusted.approverRole, undefined, 'a service principal must never carry approval authority, regardless of what the membership row stores');
});

// R — revoked membership takes effect on next authoritative context resolution
test('R: revoking a membership denies the very next resolution attempt', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A });

  const first = await ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A });
  assert.equal(first.organizationId, ORG_A);

  await ctx.memberships.updateStatus(ORG_A, 'id-1', 'REVOKED');

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A }),
    MembershipNotActiveError,
  );
});

// S — suspended identity takes effect on next context resolution
test('S: suspending an identity denies the very next resolution attempt', async () => {
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: ORG_A });

  const first = await ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A });
  assert.equal(first.identityId, 'id-1');

  await ctx.identities.updateStatus('id-1', 'suspended');

  await assert.rejects(
    ctx.service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: ORG_A }),
    InactiveIdentityError,
  );
});

// T — missing authorization bootstrap context cannot become a general tenant database bypass
// (structural proof at this layer; the full RLS-backed proof lives in test/integration)
test('T: AuthorizationService exposes exactly two public methods, neither a bypass — resolveTrustedContext (returns authority) and listEligibleOrganizations (IDENTITY-W8, returns only a plain organizationId/role list, never a TrustedOrganizationContext)', () => {
  const ctx = setup();
  const publicMembers = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.service)).filter((name) => name !== 'constructor');
  assert.deepEqual(
    publicMembers.sort(),
    ['listEligibleOrganizations', 'resolveTrustedContext'],
    'no bypass method may exist on the authorization boundary — #resolveActiveIdentity is a true JS private field and must not appear here',
  );
});
