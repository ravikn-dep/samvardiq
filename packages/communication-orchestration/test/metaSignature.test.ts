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
