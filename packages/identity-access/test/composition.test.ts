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
import { SupabaseIdentityProviderAdapter } from '../src/providers/supabaseIdentityProviderAdapter.js';
import { InMemoryIdentityProviderLinkRepository } from '../src/providerLinkRepository.js';
import type { MembershipStatus } from '../src/types.js';
import { createTestIssuer, type TestIssuer } from './jwksTestHelper.js';

/**
 * Composition tests: the REAL Supabase adapter (real cryptographic
 * verification, see supabaseAdapter.test.ts) chained into the REAL,
 * unmodified IDENTITY-W2 AuthorizationService. Proves the full
 * authentication -> authorization boundary this session exists to build,
 * without re-proving RLS/Postgres (already proven in W2's integration
 * suite against the identical AuthorizationService).
 */
function setup() {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  return { identities, providerLinks, memberships, authz };
}

async function provisionAdapter(): Promise<{ adapter: SupabaseIdentityProviderAdapter; issuer: TestIssuer }> {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  return { adapter, issuer };
}

async function provisionHuman(
  ctx: ReturnType<typeof setup>,
  opts: { identityId: string; subject: string; organizationId?: string; membershipStatus?: MembershipStatus; principalType?: 'human' | 'service' },
) {
  await ctx.identities.create({ identityId: opts.identityId, principalType: opts.principalType ?? 'human', displayName: opts.identityId });
  await ctx.providerLinks.create({ identityId: opts.identityId, provider: 'supabase', providerSubject: opts.subject });
  if (opts.organizationId) {
    await ctx.memberships.create({
      organizationId: opts.organizationId,
      identityId: opts.identityId,
      role: 'MEMBER',
      status: opts.membershipStatus ?? 'ACTIVE',
    });
  }
}

// L — arbitrary caller cannot forge provider subject into trusted identity
test('L: merely knowing/guessing a subject value grants nothing beyond what that identity\'s own real state allows', async () => {
  const ctx = setup();
  // No identity, no provider link, no membership exists anywhere for this subject —
  // an attacker who only knows (or guesses) a subject string, without ever going
  // through real adapter verification, still resolves nothing.
  await assert.rejects(
    ctx.authz.resolveTrustedContext({
      principal: { provider: 'supabase', providerSubject: 'guessed-or-leaked-subject', verifiedAt: new Date().toISOString() },
      requestedOrganizationId: 'org-A',
    }),
    ProviderIdentityNotLinkedError,
  );
});

// M — valid provider identity with no provider link -> provisioning policy enforced (reject until provisioned)
test('M: a validly authenticated Supabase user with no provider link is denied (controlled provisioning, no auto-create)', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  const token = await issuer.signToken({ sub: 'unprovisioned-user' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  assert.equal(principal.providerSubject, 'unprovisioned-user'); // authentication succeeded

  await assert.rejects(
    ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' }),
    ProviderIdentityNotLinkedError,
  ); // authorization still correctly denied — no identity was auto-created
  assert.equal(await ctx.identities.get('unprovisioned-user'), undefined, 'no identity may be silently auto-provisioned');
});

// N — valid provider identity linked to ACTIVE internal identity -> resolves
test('N: full chain — real token verification + ACTIVE identity + ACTIVE membership resolves a trusted context', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  const trusted = await ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' });

  assert.equal(trusted.identityId, 'id-1');
  assert.equal(trusted.organizationId, 'org-A');
});

// O — valid provider identity linked to SUSPENDED internal identity -> denied
test('O: a valid token for a SUSPENDED Samvardiq identity is denied despite successful provider authentication', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await ctx.identities.updateStatus('id-1', 'suspended');
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  await assert.rejects(ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' }), InactiveIdentityError);
});

// P — valid provider identity linked to REVOKED internal identity -> denied
test('P: a valid token for a REVOKED Samvardiq identity is denied despite successful provider authentication', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await ctx.identities.updateStatus('id-1', 'revoked');
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  await assert.rejects(ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' }), InactiveIdentityError);
});

// Q — valid provider identity + ACTIVE identity + no org membership -> denied
test('Q: a valid, active identity with no membership in the requested organization is denied', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1' }); // no organizationId -> no membership
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  await assert.rejects(ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' }), MembershipNotFoundError);
});

// R — valid provider identity + ACTIVE membership -> TrustedOrganizationContext (same as N, restated per the letter matrix)
test('R: valid authentication plus active membership yields a usable TrustedOrganizationContext', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  const trusted = await ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' });
  assert.equal(trusted.role, 'MEMBER');
});

// S — valid provider identity + membership in Org A requests Org B -> denied
test('S: a member of organization A is denied when requesting organization B through the full chain', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  await assert.rejects(ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-B' }), MembershipNotFoundError);
});

// T — multi-org identity may establish A and B separately only where membership exists
test('T: a multi-organization identity resolves context for A and B independently through the full chain', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await ctx.identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await ctx.providerLinks.create({ identityId: 'id-1', provider: 'supabase', providerSubject: 'sub-1' });
  await ctx.memberships.create({ organizationId: 'org-A', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });
  await ctx.memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  const contextA = await ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' });
  const contextB = await ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-B' });

  assert.equal(contextA.role, 'OWNER');
  assert.equal(contextB.role, 'VIEWER');
});

// U — membership revoked while provider authentication remains valid -> subsequent context denied
test('U: revoking membership denies the next resolution even though the same provider token is still cryptographically valid', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token }); // still valid, re-verified below too
  const first = await ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' });
  assert.equal(first.organizationId, 'org-A');

  await ctx.memberships.updateStatus('org-A', 'id-1', 'REVOKED');

  // Re-verify the SAME still-unexpired token — proves the token's continued cryptographic
  // validity does not matter once Samvardiq's own membership state says otherwise.
  const principalAgain = await adapter.verifyCredential({ rawToken: token });
  await assert.rejects(
    ctx.authz.resolveTrustedContext({ principal: principalAgain, requestedOrganizationId: 'org-A' }),
    MembershipNotActiveError,
  );
});

// V — service principal cannot enter human authorization path
test('V: a service principal authenticated through the same adapter still resolves with principalType "service", never "human"', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'svc-1', subject: 'svc-sub-1', organizationId: 'org-A', principalType: 'service' });
  const token = await issuer.signToken({ sub: 'svc-sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  const trusted = await ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' });

  assert.equal(trusted.principalType, 'service');
  assert.equal(trusted.approverRole, undefined);
});

// W — provider subject cannot be substituted for internal identityId (through the real adapter this time)
test('W: the real adapter\'s verified subject cannot be used as a shortcut past provider-link resolution', async () => {
  const { adapter, issuer } = await provisionAdapter();
  const ctx = setup();
  await provisionHuman(ctx, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await issuer.signToken({ sub: 'sub-1' });

  const principal = await adapter.verifyCredential({ rawToken: token });
  assert.equal(principal.providerSubject, 'sub-1');

  // The raw verified subject must not itself resolve a membership — only the real identityId can.
  assert.equal(await ctx.memberships.get('org-A', 'sub-1'), undefined);
  const trusted = await ctx.authz.resolveTrustedContext({ principal, requestedOrganizationId: 'org-A' });
  assert.equal(trusted.identityId, 'id-1');
  assert.notEqual(trusted.identityId, principal.providerSubject);
});
