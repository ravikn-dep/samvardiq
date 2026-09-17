import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TrustedOrganizationContext } from '@samvardiq/identity-access';

import { decodeHandoffCursor, encodeHandoffCursor, InMemoryConversationRepository } from '../src/conversationRepository.js';
import { InvalidHandoffCursorError, HumanHandoffAccessForbiddenError, classifyCommunicationError } from '../src/errors.js';
import { canReadHumanHandoffInbox, handleListHumanHandoffsRequest, type HumanHandoffReadDependencies } from '../src/humanHandoffReadService.js';
import type { Conversation } from '../src/types.js';

function baseContext(overrides: Partial<TrustedOrganizationContext> = {}): TrustedOrganizationContext {
  return {
    identityId: 'id-1',
    organizationId: 'org-A',
    membershipId: 'org-A::id-1',
    role: 'MEMBER',
    principalType: 'human',
    establishedAt: new Date().toISOString(),
    ...overrides,
  };
}

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

test('G/L: canReadHumanHandoffInbox allows any human role, ignoring approverRole entirely', () => {
  assert.equal(canReadHumanHandoffInbox(baseContext({ role: 'OWNER' })), true);
  assert.equal(canReadHumanHandoffInbox(baseContext({ role: 'MEMBER' })), true);
  assert.equal(canReadHumanHandoffInbox(baseContext({ role: 'VIEWER' })), true);
  assert.equal(canReadHumanHandoffInbox(baseContext({ role: 'VIEWER', approverRole: undefined })), true);
});

test('F/AC: canReadHumanHandoffInbox denies a service principal regardless of role or membership', () => {
  assert.equal(canReadHumanHandoffInbox(baseContext({ principalType: 'service', role: 'OWNER' })), false);
  assert.equal(canReadHumanHandoffInbox(baseContext({ principalType: 'service', role: 'MEMBER' })), false);
});

test('Q: a malformed (non-base64/non-JSON) cursor is rejected outright, never guessed at', () => {
  assert.throws(() => decodeHandoffCursor('not-a-real-cursor!!'), InvalidHandoffCursorError);
  assert.throws(() => decodeHandoffCursor(Buffer.from('{"not":"a cursor"}').toString('base64url')), InvalidHandoffCursorError);
  assert.throws(() => decodeHandoffCursor(Buffer.from('null').toString('base64url')), InvalidHandoffCursorError);
});

test('a valid cursor round-trips exactly', () => {
  const cursor = { updatedAt: '2026-01-01T00:00:00.000Z', conversationId: 'conv-9' };
  assert.deepEqual(decodeHandoffCursor(encodeHandoffCursor(cursor)), cursor);
});

test('classifyCommunicationError maps the new errors to non-500 client-safe responses', () => {
  assert.deepEqual(classifyCommunicationError(new HumanHandoffAccessForbiddenError()), { errorClass: 'FORBIDDEN', httpStatus: 403, message: 'Access denied.' });
  assert.deepEqual(classifyCommunicationError(new InvalidHandoffCursorError()), { errorClass: 'BAD_REQUEST', httpStatus: 400, message: 'Invalid request.' });
  assert.equal(classifyCommunicationError(new Error('anything else')).errorClass, 'INTERNAL');
});

test('M/N/O: listHumanHandoffs returns only HUMAN_HANDOFF_REQUESTED conversations for the given organization', async () => {
  const repo = new InMemoryConversationRepository();
  await repo.create(conversation({ conversationId: 'c-handoff', state: 'HUMAN_HANDOFF_REQUESTED' }));
  await repo.create(conversation({ conversationId: 'c-ai-active', state: 'AI_ACTIVE', handoffTrigger: undefined, handoffAt: undefined }));
  await repo.create(conversation({ conversationId: 'c-resolved', state: 'RESOLVED' }));
  await repo.create(conversation({ conversationId: 'c-closed', state: 'CLOSED' }));
  await repo.create(conversation({ conversationId: 'c-other-org', organizationId: 'org-B' }));

  const page = await repo.listHumanHandoffs('org-A', { limit: 20 });
  assert.deepEqual(page.items.map((c) => c.conversationId), ['c-handoff']);
});

test('P/Q/R/S: pagination is bounded, stable-ordered, and never repeats a row across pages', async () => {
  const repo = new InMemoryConversationRepository();
  const ids: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    const id = `c-${String(i).padStart(2, '0')}`;
    ids.push(id);
    // Distinct updatedAt per row so ordering is unambiguous.
    await repo.create(conversation({ conversationId: id, updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() }));
  }

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await repo.listHumanHandoffs('org-A', { limit: 10, cursor });
    assert.ok(result.items.length <= 10, 'page size must never exceed the requested limit');
    seen.push(...result.items.map((c) => c.conversationId));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  assert.equal(seen.length, 25, 'every row must be seen exactly once across all pages');
  assert.equal(new Set(seen).size, 25, 'no duplicate rows across pagination');
  // Highest updatedAt first (DESC) — the 25th-created row (highest updatedAt) appears first.
  assert.equal(seen[0], 'c-24');
  assert.equal(seen[seen.length - 1], 'c-00');
});

test('an invalid cursor passed through listHumanHandoffs fails the same way as decodeHandoffCursor', async () => {
  const repo = new InMemoryConversationRepository();
  await assert.rejects(repo.listHumanHandoffs('org-A', { limit: 10, cursor: 'garbage' }), InvalidHandoffCursorError);
});

function fakeIdentityProvider(principalFor: (rawToken: string) => { provider: string; providerSubject: string } | null) {
  return {
    provider: 'test',
    async verifyCredential({ rawToken }: { rawToken: string }) {
      const principal = principalFor(rawToken);
      if (!principal) throw new Error('invalid token');
      return { provider: principal.provider, providerSubject: principal.providerSubject, verifiedAt: new Date().toISOString() };
    },
  };
}

test('AM: the DTO never carries externalContactId (raw WhatsApp phone) or any raw-persistence-only field', async () => {
  const { InMemoryIdentityRepository, InMemoryIdentityProviderLinkRepository, InMemoryMembershipRepository, AuthorizationService } = await import('@samvardiq/identity-access');
  const { InMemoryOrganizationRepository } = await import('@samvardiq/data-foundation');

  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const organizations = new InMemoryOrganizationRepository();
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  await identities.create({ identityId: 'staff-1', principalType: 'human', displayName: 'staff-1' });
  await providerLinks.create({ identityId: 'staff-1', provider: 'test', providerSubject: 'sub-staff-1' });
  await memberships.create({ organizationId: 'org-A', identityId: 'staff-1', role: 'MEMBER', status: 'ACTIVE' });

  const conversations = new InMemoryConversationRepository();
  await conversations.create(conversation());

  const deps: HumanHandoffReadDependencies = {
    identityProvider: fakeIdentityProvider(() => ({ provider: 'test', providerSubject: 'sub-staff-1' })),
    authz,
    organizations,
    conversations,
  };

  const page = await handleListHumanHandoffsRequest(deps, { authorizationHeader: 'Bearer any', requestedOrganizationId: 'org-A', limit: 10 });
  assert.equal(page.items.length, 1);
  const keys = Object.keys(page.items[0]!);
  assert.ok(!keys.includes('externalContactId'));
  assert.deepEqual(
    keys.sort(),
    ['activeAppointmentId', 'activeEnquiryId', 'bookingState', 'channelId', 'conversationId', 'createdAt', 'externalPatientId', 'handoffAt', 'handoffTrigger', 'preferredLanguage', 'state', 'updatedAt'].sort(),
  );
});

test('F: a service principal is denied even with an ACTIVE membership', async () => {
  const { InMemoryIdentityRepository, InMemoryIdentityProviderLinkRepository, InMemoryMembershipRepository, AuthorizationService } = await import('@samvardiq/identity-access');
  const { InMemoryOrganizationRepository } = await import('@samvardiq/data-foundation');

  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const organizations = new InMemoryOrganizationRepository();
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  await identities.create({ identityId: 'svc-whatsapp-chan-1', principalType: 'service', displayName: 'chan-1', status: 'active' });
  await providerLinks.create({ identityId: 'svc-whatsapp-chan-1', provider: 'whatsapp-channel', providerSubject: 'chan-1' });
  await memberships.create({ organizationId: 'org-A', identityId: 'svc-whatsapp-chan-1', role: 'MEMBER', status: 'ACTIVE' });

  const deps: HumanHandoffReadDependencies = {
    identityProvider: fakeIdentityProvider(() => ({ provider: 'whatsapp-channel', providerSubject: 'chan-1' })),
    authz,
    organizations,
    conversations: new InMemoryConversationRepository(),
  };

  await assert.rejects(
    handleListHumanHandoffsRequest(deps, { authorizationHeader: 'Bearer any', requestedOrganizationId: 'org-A', limit: 10 }),
    HumanHandoffAccessForbiddenError,
  );
});
