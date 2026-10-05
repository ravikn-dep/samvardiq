import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthorizationService, InMemoryIdentityProviderLinkRepository, InMemoryIdentityRepository, InMemoryMembershipRepository, type TrustedOrganizationContext } from '@samvardiq/identity-access';
import { InMemoryOrganizationRepository } from '@samvardiq/data-foundation';
import type { IdentityProviderAdapter, VerifiedPrincipal } from '@samvardiq/identity-access';

import { InMemoryConversationRepository } from '../src/conversationRepository.js';
import { HumanHandoffAccessForbiddenError, HumanHandoffConflictError, HumanHandoffNotFoundError, classifyCommunicationError } from '../src/errors.js';
import { canManageHumanHandoff, handleClaimHumanHandoffRequest, handleResolveHumanHandoffRequest, type HumanHandoffManagementDependencies } from '../src/humanHandoffManagementService.js';
import { handleListHumanHandoffsRequest } from '../src/humanHandoffReadService.js';
import type { Conversation } from '../src/types.js';

/** CLINIC-W2D adversarial matrix at the service boundary, through the real AuthorizationService (in-memory stores). */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = new Date().toISOString();
  return {
    conversationId: 'conv-1',
    organizationId: 'org-A',
    channelId: 'chan-1',
    externalContactId: '919876543210',
    state: 'HUMAN_HANDOFF_REQUESTED',
    preferredLanguage: 'en-IN',
    bookingState: 'HUMAN_HANDOFF_REQUESTED',
    handoffTrigger: 'AMBIGUOUS_PATIENT_MATCH',
    handoffAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** The bearer token IS the provider subject in these tests — the real token verification is proven elsewhere. */
const tokenIsSubject: IdentityProviderAdapter = {
  provider: 'test',
  async verifyCredential(credential): Promise<VerifiedPrincipal> {
    return { provider: 'test', providerSubject: credential.rawToken, verifiedAt: new Date().toISOString() };
  },
};

async function buildWorld() {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const organizations = new InMemoryOrganizationRepository();
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  for (const org of ['org-A', 'org-B']) await organizations.create({ organizationId: org, organizationType: 'clinic', name: org });

  const people: [string, 'human' | 'service', string, 'OWNER' | 'MEMBER' | 'VIEWER', 'ACTIVE' | 'SUSPENDED'][] = [
    ['owner-a', 'human', 'org-A', 'OWNER', 'ACTIVE'],
    ['member-a', 'human', 'org-A', 'MEMBER', 'ACTIVE'],
    ['member2-a', 'human', 'org-A', 'MEMBER', 'ACTIVE'],
    ['viewer-a', 'human', 'org-A', 'VIEWER', 'ACTIVE'],
    ['suspended-a', 'human', 'org-A', 'MEMBER', 'SUSPENDED'],
    ['svc-a', 'service', 'org-A', 'MEMBER', 'ACTIVE'],
    ['member-b', 'human', 'org-B', 'MEMBER', 'ACTIVE'],
  ];
  for (const [id, principalType, org, role, status] of people) {
    await identities.create({ identityId: id, principalType, displayName: id });
    await providerLinks.create({ identityId: id, provider: 'test', providerSubject: id });
    await memberships.create({ organizationId: org, identityId: id, role, status });
  }
  await identities.create({ identityId: 'outsider', principalType: 'human', displayName: 'outsider' });
  await providerLinks.create({ identityId: 'outsider', provider: 'test', providerSubject: 'outsider' });

  const conversations = new InMemoryConversationRepository();
  await conversations.create(conversation());
  await conversations.create(conversation({ conversationId: 'conv-ai', state: 'AI_ACTIVE', bookingState: 'NEW', handoffTrigger: undefined, handoffAt: undefined }));
  await conversations.create(conversation({ organizationId: 'org-B', conversationId: 'conv-b' }));

  const deps: HumanHandoffManagementDependencies = { identityProvider: tokenIsSubject, authz, organizations, conversations };
  const as = (who: string, org = 'org-A') => ({ authorizationHeader: `Bearer ${who}`, requestedOrganizationId: org });
  const claim = (who: string, conversationId = 'conv-1', org = 'org-A') => handleClaimHumanHandoffRequest(deps, { ...as(who, org), conversationId });
  const resolve = (who: string, outcome: 'RETURN_TO_AI' | 'CLOSE', conversationId = 'conv-1', org = 'org-A') =>
    handleResolveHumanHandoffRequest(deps, { ...as(who, org), conversationId, outcome });
  const events = (conversationId = 'conv-1', org = 'org-A') => conversations.listHandoffEvents(org, conversationId);
  return { deps, conversations, as, claim, resolve, events };
}

const forbidden = (e: unknown) => e instanceof HumanHandoffAccessForbiddenError;
const conflict = (e: unknown) => e instanceof HumanHandoffConflictError;
const notFound = (e: unknown) => e instanceof HumanHandoffNotFoundError;

test('canManageHumanHandoff: human OWNER and MEMBER only — never VIEWER, never a service principal', () => {
  const ctx = (role: TrustedOrganizationContext['role'], principalType: TrustedOrganizationContext['principalType']): TrustedOrganizationContext => ({
    identityId: 'x', organizationId: 'org-A', membershipId: 'org-A::x', role, principalType, establishedAt: new Date().toISOString(),
  });
  assert.equal(canManageHumanHandoff(ctx('OWNER', 'human')), true);
  assert.equal(canManageHumanHandoff(ctx('MEMBER', 'human')), true);
  assert.equal(canManageHumanHandoff(ctx('VIEWER', 'human')), false);
  for (const role of ['OWNER', 'MEMBER', 'VIEWER'] as const) assert.equal(canManageHumanHandoff(ctx(role, 'service')), false);
});

test('A/R/Z: a human MEMBER claims an unclaimed handoff; it stays in the inbox with owner and claim time; CLAIMED is audited', async () => {
  const w = await buildWorld();
  const summary = await w.claim('member-a');
  assert.equal(summary.state, 'HUMAN_ACTIVE');
  assert.equal(summary.handoffOwnerIdentityId, 'member-a');
  assert.ok(summary.handoffClaimedAt);
  const inbox = await handleListHumanHandoffsRequest(w.deps, { ...w.as('viewer-a'), limit: 10 });
  assert.deepEqual(inbox.items.map((i) => [i.conversationId, i.state, i.handoffOwnerIdentityId]), [['conv-1', 'HUMAN_ACTIVE', 'member-a']]);
  const [claimed] = await w.events();
  assert.deepEqual(
    { type: claimed!.eventType, actor: claimed!.actorIdentityId, principal: claimed!.actorPrincipalType, trigger: claimed!.handoffTrigger, outcome: claimed!.outcome },
    { type: 'CLAIMED', actor: 'member-a', principal: 'human', trigger: 'AMBIGUOUS_PATIENT_MATCH', outcome: undefined },
  );
  assert.ok(!JSON.stringify(claimed).includes('919876543210'), 'no contact number in the audit record');
});

test('C/M: re-claim by the owner is idempotent (no second event); a different human gets a deterministic conflict', async () => {
  const w = await buildWorld();
  await w.claim('member-a');
  assert.equal((await w.claim('member-a')).handoffOwnerIdentityId, 'member-a');
  await assert.rejects(w.claim('member2-a'), conflict);
  await assert.rejects(w.claim('owner-a'), conflict, 'an OWNER cannot take over a claimed handoff in W2D');
  assert.equal((await w.events()).length, 1);
  assert.equal((await w.conversations.getById('org-A', 'conv-1'))!.handoffOwnerIdentityId, 'member-a');
});

test('B (in-memory): concurrent claims by two humans produce exactly one owner and one CLAIMED event', async () => {
  const w = await buildWorld();
  const results = await Promise.allSettled([w.claim('member-a'), w.claim('member2-a'), w.claim('owner-a')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && conflict(r.reason)).length, 2);
  assert.equal((await w.events()).length, 1);
});

test('D/E/J: VIEWER, a service principal, a suspended member and a non-member can neither claim nor resolve', async () => {
  const w = await buildWorld();
  await assert.rejects(w.claim('viewer-a'), forbidden);
  await assert.rejects(w.claim('svc-a'), forbidden);
  await assert.rejects(w.claim('suspended-a'));
  await assert.rejects(w.claim('outsider'));
  await w.claim('member-a');
  await assert.rejects(w.resolve('svc-a', 'CLOSE'), forbidden);
  await assert.rejects(w.resolve('viewer-a', 'CLOSE'), forbidden);
  assert.equal((await w.conversations.getById('org-A', 'conv-1'))!.state, 'HUMAN_ACTIVE');
  assert.equal((await w.events()).length, 1);
});

test('F/K/AC: an org-B human can neither claim nor resolve org-A handoffs — via org A (not a member) or via its own org (not found)', async () => {
  const w = await buildWorld();
  await assert.rejects(w.claim('member-b', 'conv-1', 'org-A'));
  await assert.rejects(w.claim('member-b', 'conv-1', 'org-B'), notFound);
  await w.claim('member-a');
  await assert.rejects(w.resolve('member-b', 'CLOSE', 'conv-1', 'org-B'), notFound);
  await assert.rejects(w.resolve('member-b', 'CLOSE', 'conv-1', 'org-A'));
  assert.equal((await w.conversations.getById('org-A', 'conv-1'))!.state, 'HUMAN_ACTIVE');
  assert.equal((await w.conversations.getById('org-B', 'conv-b'))!.state, 'HUMAN_HANDOFF_REQUESTED');
});

test('I/L: only the current owner resolves; resolving an unclaimed handoff or claiming a non-handoff conversation conflicts', async () => {
  const w = await buildWorld();
  await assert.rejects(w.resolve('member-a', 'CLOSE'), conflict, 'unclaimed handoff cannot be resolved');
  await assert.rejects(w.claim('member-a', 'conv-ai'), conflict, 'an AI_ACTIVE conversation is not claimable');
  await w.claim('member-a');
  await assert.rejects(w.resolve('member2-a', 'CLOSE'), conflict);
  await assert.rejects(w.resolve('owner-a', 'RETURN_TO_AI'), conflict, 'no OWNER override in W2D');
  assert.equal((await w.events()).length, 1);
});

test('G/AA/R: owner RETURN_TO_AI -> AI_ACTIVE with owner cleared; the RESOLVED event keeps owner, outcome and trigger provenance', async () => {
  const w = await buildWorld();
  await w.claim('member-a');
  const result = await w.resolve('member-a', 'RETURN_TO_AI');
  assert.deepEqual(result, { conversationId: 'conv-1', state: 'AI_ACTIVE', outcome: 'RETURN_TO_AI' });
  const after = (await w.conversations.getById('org-A', 'conv-1'))!;
  assert.equal(after.handoffOwnerIdentityId, undefined);
  assert.equal(after.handoffClaimedAt, undefined);
  assert.equal(after.bookingState, 'NEW');
  const resolved = (await w.events()).at(-1)!;
  assert.deepEqual(
    { type: resolved.eventType, actor: resolved.actorIdentityId, outcome: resolved.outcome, trigger: resolved.handoffTrigger },
    { type: 'RESOLVED', actor: 'member-a', outcome: 'RETURN_TO_AI', trigger: 'AMBIGUOUS_PATIENT_MATCH' },
  );
});

test('H/U/M: owner CLOSE -> CLOSED, leaves the inbox; a duplicate resolution conflicts and adds no event', async () => {
  const w = await buildWorld();
  await w.claim('owner-a');
  assert.equal((await w.resolve('owner-a', 'CLOSE')).state, 'CLOSED');
  const inbox = await handleListHumanHandoffsRequest(w.deps, { ...w.as('member-a'), limit: 10 });
  assert.deepEqual(inbox.items.map((i) => i.conversationId), []);
  await assert.rejects(w.resolve('owner-a', 'CLOSE'), conflict);
  await assert.rejects(w.resolve('owner-a', 'RETURN_TO_AI'), conflict);
  assert.deepEqual((await w.events()).map((e) => e.eventType), ['CLAIMED', 'RESOLVED']);
});

test('Q: no credential fails closed before any repository access', async () => {
  const w = await buildWorld();
  await assert.rejects(handleClaimHumanHandoffRequest(w.deps, { authorizationHeader: undefined, requestedOrganizationId: 'org-A', conversationId: 'conv-1' }));
  await assert.rejects(handleResolveHumanHandoffRequest(w.deps, { authorizationHeader: undefined, requestedOrganizationId: 'org-A', conversationId: 'conv-1', outcome: 'CLOSE' }));
  assert.equal((await w.events()).length, 0);
});

test('error classification: 404 not found, 409 conflict, generic messages', () => {
  assert.deepEqual(classifyCommunicationError(new HumanHandoffNotFoundError()), { errorClass: 'NOT_FOUND', httpStatus: 404, message: 'Not found.' });
  assert.equal(classifyCommunicationError(new HumanHandoffConflictError()).httpStatus, 409);
});
