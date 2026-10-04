import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { verifyMetaWebhookHandshake, verifyMetaWebhookSignature } from '../src/metaSignature.js';

const SECRET = 'reference-vector-app-secret-at-least-32-characters';

test('A: a correctly signed body verifies (independent HMAC computation, not the function under test called twice)', () => {
  const body = '{"object":"whatsapp_business_account"}';
  const expected = createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(verifyMetaWebhookSignature(body, `sha256=${expected}`, SECRET), true);
});

test('B: an invalid signature is rejected', () => {
  const body = '{"object":"whatsapp_business_account"}';
  assert.equal(verifyMetaWebhookSignature(body, `sha256=${'0'.repeat(64)}`, SECRET), false);
});

test('a missing signature header is rejected', () => {
  assert.equal(verifyMetaWebhookSignature('{}', undefined, SECRET), false);
});

test('a signature missing the sha256= prefix is rejected', () => {
  const body = '{}';
  const expected = createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(verifyMetaWebhookSignature(body, expected, SECRET), false);
});

test('a malformed (non-hex) signature is rejected without throwing', () => {
  assert.equal(verifyMetaWebhookSignature('{}', 'sha256=not-hex-at-all', SECRET), false);
});

test('raw-body mutation invalidates a previously-correct signature', () => {
  const original = '{"a":1}';
  const mutated = '{"a":2}';
  const signature = `sha256=${createHmac('sha256', SECRET).update(original).digest('hex')}`;
  assert.equal(verifyMetaWebhookSignature(mutated, signature, SECRET), false);
});

test('a different app secret invalidates a correctly-shaped signature', () => {
  const body = '{}';
  const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  assert.equal(verifyMetaWebhookSignature(body, signature, 'a-totally-different-secret-value-32ch'), false);
});

test('webhook verification handshake: correct mode + token echoes the challenge', () => {
  const result = verifyMetaWebhookHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'expected-token', 'hub.challenge': '12345' }, 'expected-token');
  assert.equal(result, '12345');
});

test('webhook verification handshake: wrong token is rejected', () => {
  const result = verifyMetaWebhookHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' }, 'expected-token');
  assert.equal(result, null);
});

test('webhook verification handshake: wrong mode is rejected', () => {
  const result = verifyMetaWebhookHandshake({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'expected-token', 'hub.challenge': '12345' }, 'expected-token');
  assert.equal(result, null);
});

/**
 * CLINIC-W2-SEC-F1: an unset META_WEBHOOK_VERIFY_TOKEN reaches this primitive as '' (index.ts `?? ''`). A missing,
 * empty or whitespace-only configured token must never authenticate — not even against an equally empty query value.
 */
const ok = { 'hub.mode': 'subscribe', 'hub.verify_token': 'expected-token', 'hub.challenge': '12345' };

test('SEC-F1 A: empty configured token + empty incoming token is rejected (the reproduced fail-open)', () => {
  assert.equal(verifyMetaWebhookHandshake({ ...ok, 'hub.verify_token': '' }, ''), null);
});

test('SEC-F1 B: empty or whitespace-only configured token rejects any incoming token', () => {
  for (const configured of ['', ' ', '\t\n']) {
    for (const incoming of ['', ' ', 'anything', configured]) {
      assert.equal(verifyMetaWebhookHandshake({ ...ok, 'hub.verify_token': incoming }, configured), null, JSON.stringify({ configured, incoming }));
    }
  }
});

test('SEC-F1 C: valid configured token + empty or missing incoming token is rejected', () => {
  assert.equal(verifyMetaWebhookHandshake({ ...ok, 'hub.verify_token': '' }, 'expected-token'), null);
  assert.equal(verifyMetaWebhookHandshake({ 'hub.mode': 'subscribe', 'hub.challenge': '12345' }, 'expected-token'), null);
});

test('SEC-F1 D: near-miss tokens (prefix, suffix, case, padding) are rejected', () => {
  for (const incoming of ['expected-toke', 'expected-tokenX', 'EXPECTED-TOKEN', ' expected-token', 'expected-token ']) {
    assert.equal(verifyMetaWebhookHandshake({ ...ok, 'hub.verify_token': incoming }, 'expected-token'), null, incoming);
  }
});

test('SEC-F1 G: missing mode, or a missing or empty challenge, never yields a success', () => {
  assert.equal(verifyMetaWebhookHandshake({ 'hub.verify_token': 'expected-token', 'hub.challenge': '12345' }, 'expected-token'), null);
  assert.equal(verifyMetaWebhookHandshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'expected-token' }, 'expected-token'), null);
  assert.equal(verifyMetaWebhookHandshake({ ...ok, 'hub.challenge': '' }, 'expected-token'), null);
});
