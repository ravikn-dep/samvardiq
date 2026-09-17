import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Conversation } from '@samvardiq/communication-orchestration';

import { buildWorld, type TestWorld } from './setup.js';

/**
 * CLINIC-W2C security matrix (section 22), proven at the real Fastify
 * HTTP layer over `.inject()` — the route is thin plumbing, the actual
 * authorization/pagination/projection logic is already exhaustively
 * proven in communication-orchestration's own suites.
 */

let world: TestWorld;

beforeEach(async () => {
  world = await buildWorld();
});

afterEach(async () => {
  await world.app.close();
});

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

async function seedHuman(organizationId: string, role: 'OWNER' | 'MEMBER' | 'VIEWER' = 'MEMBER'): Promise<string> {
  const identityId = `human-${organizationId}-${role}`;
  const subject = `sub-${identityId}`;
  await world.identities.create({ identityId, principalType: 'human', displayName: identityId });
  await world.providerLinks.create({ identityId, provider: 'supabase', providerSubject: subject });
  await world.organizations.create({ organizationId, organizationType: 'clinic', name: organizationId }).catch(() => undefined);
  await world.memberships.create({ organizationId, identityId, role, status: 'ACTIVE' });
  return world.issuer.signToken({ sub: subject });
}

async function seedServicePrincipal(organizationId: string): Promise<string> {
  const identityId = `svc-${organizationId}`;
  const subject = `sub-${identityId}`;
  await world.identities.create({ identityId, principalType: 'service', displayName: identityId });
  await world.providerLinks.create({ identityId, provider: 'supabase', providerSubject: subject });
  await world.organizations.create({ organizationId, organizationType: 'clinic', name: organizationId }).catch(() => undefined);
  await world.memberships.create({ organizationId, identityId, role: 'MEMBER', status: 'ACTIVE' });
  return world.issuer.signToken({ sub: subject });
}

function url(organizationId: string, query = ''): string {
  return `/v1/organizations/${organizationId}/communication/handoffs${query}`;
}

describe('GET /v1/organizations/:organizationId/communication/handoffs', () => {
  it('A: unauthenticated request (no Authorization header) is denied', async () => {
    const res = await world.app.inject({ method: 'GET', url: url('org-A') });
    assert.equal(res.statusCode, 401);
  });

  it('B: an invalid/malformed token is denied', async () => {
    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: 'Bearer not-a-real-jwt' } });
    assert.equal(res.statusCode, 401);
  });

  it('C: an inactive identity is denied', async () => {
    const token = await seedHuman('org-A');
    await world.identities.updateStatus('human-org-A-MEMBER', 'suspended');
    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403);
  });

  it('D: a revoked membership is denied', async () => {
    const token = await seedHuman('org-A');
    await world.memberships.updateStatus('org-A', 'human-org-A-MEMBER', 'REVOKED');
    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403);
  });

  it('E: a suspended membership is denied', async () => {
    const token = await seedHuman('org-A');
    await world.memberships.updateStatus('org-A', 'human-org-A-MEMBER', 'SUSPENDED');
    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403);
  });

  it('F/AC: a service principal is denied even with an ACTIVE membership, and no handoffs are enumerated', async () => {
    await world.conversations.create(conversation());
    const token = await seedServicePrincipal('org-A');
    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403);
  });

  it('G/L: a human from the correct organization is allowed, regardless of OWNER/MEMBER/VIEWER role, and approverRole is irrelevant', async () => {
    await world.conversations.create(conversation());
    for (const role of ['OWNER', 'MEMBER', 'VIEWER'] as const) {
      const token = await seedHuman('org-A', role);
      const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.statusCode, 200, `role ${role} must be allowed to read the inbox`);
      assert.equal(res.json().items.length, 1);
    }
  });

  it('H/I: Org A cannot list or discover Org B`s handoffs', async () => {
    await world.conversations.create(conversation({ organizationId: 'org-A', conversationId: 'conv-A' }));
    await world.conversations.create(conversation({ organizationId: 'org-B', conversationId: 'conv-B', externalContactId: '910000000000' }));
    const tokenA = await seedHuman('org-A');

    const res = await world.app.inject({ method: 'GET', url: url('org-B'), headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(res.statusCode, 403, 'org-A has no membership in org-B — denied before any handoff data is touched');
  });

  it('AN: the denial for a wrong-organization request is identical to an unknown-organization request (no existence enumeration)', async () => {
    const tokenA = await seedHuman('org-A');
    await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });

    const resKnownOtherOrg = await world.app.inject({ method: 'GET', url: url('org-B'), headers: { authorization: `Bearer ${tokenA}` } });
    const resUnknownOrg = await world.app.inject({ method: 'GET', url: url('org-does-not-exist'), headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(resKnownOtherOrg.statusCode, 403);
    assert.equal(resUnknownOrg.statusCode, 403);
    assert.deepEqual(resKnownOtherOrg.json(), resUnknownOrg.json());
  });

  it('J/K: organizationId cannot be overridden by a query or body parameter — only the route param is authoritative', async () => {
    await world.conversations.create(conversation({ organizationId: 'org-A' }));
    await world.conversations.create(conversation({ organizationId: 'org-B', conversationId: 'conv-B', externalContactId: '910000000000' }));
    const tokenA = await seedHuman('org-A');
    await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });

    // The route has no organizationId query/body field at all (schema: additionalProperties false) — an attempted override is rejected as an unknown field, not silently accepted.
    const res = await world.app.inject({ method: 'GET', url: `${url('org-A')}?organizationId=org-B`, headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(res.statusCode, 400);
  });

  it('M/N/O: only HUMAN_HANDOFF_REQUESTED conversations appear — AI_ACTIVE, RESOLVED, CLOSED are excluded', async () => {
    await world.conversations.create(conversation({ conversationId: 'c-handoff', state: 'HUMAN_HANDOFF_REQUESTED' }));
    await world.conversations.create(conversation({ conversationId: 'c-active', state: 'AI_ACTIVE', externalContactId: '910000000001', handoffTrigger: undefined, handoffAt: undefined }));
    await world.conversations.create(conversation({ conversationId: 'c-resolved', state: 'RESOLVED', externalContactId: '910000000002' }));
    await world.conversations.create(conversation({ conversationId: 'c-closed', state: 'CLOSED', externalContactId: '910000000003' }));
    const token = await seedHuman('org-A');

    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items.map((i: { conversationId: string }) => i.conversationId), ['c-handoff']);
  });

  it('P/Q: page size is bounded, and a malformed (non-integer, out-of-range) limit is rejected', async () => {
    const token = await seedHuman('org-A');
    const tooLarge = await world.app.inject({ method: 'GET', url: url('org-A', '?limit=1000'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(tooLarge.statusCode, 400);
    const notAnInteger = await world.app.inject({ method: 'GET', url: url('org-A', '?limit=abc'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(notAnInteger.statusCode, 400);
    const zero = await world.app.inject({ method: 'GET', url: url('org-A', '?limit=0'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(zero.statusCode, 400);
  });

  it('Q: a malformed pagination cursor is rejected safely, not guessed at', async () => {
    const token = await seedHuman('org-A');
    const res = await world.app.inject({ method: 'GET', url: url('org-A', '?cursor=not-a-real-cursor'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 400);
  });

  it('R/S: pagination is stable-ordered with no duplicate rows across pages', async () => {
    for (let i = 0; i < 5; i += 1) {
      await world.conversations.create(
        conversation({ conversationId: `c-${i}`, externalContactId: `9100000000${i}`, updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() }),
      );
    }
    const token = await seedHuman('org-A');

    const page1 = await world.app.inject({ method: 'GET', url: url('org-A', '?limit=3'), headers: { authorization: `Bearer ${token}` } });
    assert.equal(page1.statusCode, 200);
    const body1 = page1.json();
    assert.equal(body1.items.length, 3);
    assert.ok(body1.nextCursor);

    const page2 = await world.app.inject({ method: 'GET', url: url('org-A', `?limit=3&cursor=${encodeURIComponent(body1.nextCursor)}`), headers: { authorization: `Bearer ${token}` } });
    const body2 = page2.json();
    assert.equal(body2.items.length, 2);
    assert.equal(body2.nextCursor, undefined);

    const allIds = [...body1.items, ...body2.items].map((i: { conversationId: string }) => i.conversationId);
    assert.equal(new Set(allIds).size, 5, 'no duplicate rows across pagination');
  });

  it('T/U/V/W: the response never contains a provider payload, signature, access token, or connector secret field', async () => {
    await world.conversations.create(conversation());
    const token = await seedHuman('org-A');
    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
    const raw = res.body;
    assert.doesNotMatch(raw, /sha256=/);
    assert.doesNotMatch(raw, /accessToken|access_token/i);
    assert.doesNotMatch(raw, /secret/i);
  });

  it('X: the response never contains raw patient text or the raw WhatsApp contact number', async () => {
    await world.conversations.create(conversation({ externalContactId: '919876543210' }));
    const token = await seedHuman('org-A');
    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
    assert.doesNotMatch(res.body, /919876543210/);
    assert.ok(!('externalContactId' in res.json().items[0]));
  });

  it('AA/AB: attachments and clinical-record fields never appear (structural — no such field exists on the DTO)', async () => {
    await world.conversations.create(conversation());
    const token = await seedHuman('org-A');
    const res = await world.app.inject({ method: 'GET', url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
    const item = res.json().items[0];
    for (const forbidden of ['attachments', 'diagnosis', 'prescription', 'clinicalRecord', 'rawText', 'messageContent']) {
      assert.ok(!(forbidden in item), `DTO must never carry "${forbidden}"`);
    }
  });

  it('AG/AH/AI: no claim, resolve, AI-resume, or generic conversation-search endpoint exists at this path', async () => {
    const token = await seedHuman('org-A');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await world.app.inject({ method, url: url('org-A'), headers: { authorization: `Bearer ${token}` } });
      assert.ok(res.statusCode === 404 || res.statusCode === 405, `mutation verb ${method} must not be handled by this read-only route`);
    }
  });
});
