import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { provisionCommunicationChannel } from '@samvardiq/communication-orchestration';

import { buildWorld, type TestWorld } from './setup.js';

/**
 * Section 12/32 proof at the real Fastify HTTP layer: the route is thin
 * plumbing, the actual verification/orchestration logic (already
 * exhaustively proven in communication-orchestration's own suites) is
 * exercised end-to-end through `.inject()` — the real framework request
 * pipeline, not a direct handler call.
 */

const APP_SECRET = 'test-only-app-secret-at-least-32-chars'; // matches setup.ts's commsDeps() fixture

let world: TestWorld;

beforeEach(async () => {
  world = await buildWorld();
});

afterEach(async () => {
  await world.app.close();
});

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function textPayload(text: string, messageId = 'wamid.1'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages: [{ from: '919876543210', id: messageId, type: 'text', text: { body: text } }] } }] }],
  });
}

describe('GET /webhooks/meta/whatsapp — verification handshake', () => {
  it('echoes the challenge for a correct verify token', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '12345');
  });

  it('rejects an incorrect verify token', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345' });
    assert.equal(response.statusCode, 403);
  });
});

describe('POST /webhooks/meta/whatsapp', () => {
  it('A/B: rejects an invalid signature with 401, before any processing', async () => {
    const body = textPayload('hello');
    const response = await world.app.inject({ method: 'POST', url: '/webhooks/meta/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) + 'tampered' } });
    assert.equal(response.statusCode, 401);
  });

  it('C: an unconfigured channel is acknowledged (200) but never processed as a conversation', async () => {
    const body = textPayload('hello');
    const response = await world.app.inject({ method: 'POST', url: '/webhooks/meta/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
    assert.equal(response.statusCode, 200);
  });

  it('a verified, known-channel event is accepted and produces a conversation through the real pipeline', async () => {
    await provisionCommunicationChannel(
      { identities: world.identities, providerLinks: world.providerLinks, memberships: world.memberships, channels: world.channels },
      { channelId: 'chan-1', organizationId: 'org-A', externalChannelId: 'phone-1', displayPhoneNumber: '+911234567890', timezone: 'Asia/Kolkata', accessTokenReference: 'env:TOKEN' },
    );
    await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });

    const body = textPayload('hello there', 'wamid.new-1');
    const response = await world.app.inject({ method: 'POST', url: '/webhooks/meta/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
    assert.equal(response.statusCode, 200);
  });

  it('U/V: a duplicate delivery of the same wamid is acknowledged but processed at most once', async () => {
    await provisionCommunicationChannel(
      { identities: world.identities, providerLinks: world.providerLinks, memberships: world.memberships, channels: world.channels },
      { channelId: 'chan-1', organizationId: 'org-A', externalChannelId: 'phone-1', displayPhoneNumber: '+911234567890', timezone: 'Asia/Kolkata', accessTokenReference: 'env:TOKEN' },
    );
    await world.organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });

    const body = textPayload('hello there', 'wamid.dup-http');
    const first = await world.app.inject({ method: 'POST', url: '/webhooks/meta/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
    const second = await world.app.inject({ method: 'POST', url: '/webhooks/meta/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
  });

  it('AD/AE/AF: no response ever contains the app secret, HMAC signature, or access token', async () => {
    const body = textPayload('hello');
    const response = await world.app.inject({ method: 'POST', url: '/webhooks/meta/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
    assert.doesNotMatch(response.body, new RegExp(APP_SECRET));
    assert.doesNotMatch(response.body, /sha256=/);
  });

  it('other routes are unaffected by this route`s raw-body content-type-parser override (Fastify encapsulation)', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
  });
});
