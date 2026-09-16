import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OutboundSendFailedError } from '../src/errors.js';
import { WhatsAppCloudProvider } from '../src/communicationProvider.js';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

test('AT: sends a session message with the exact documented request shape', async () => {
  let capturedBody: unknown;
  let capturedUrl: string | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT1' }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new WhatsAppCloudProvider();
  const result = await provider.sendSessionMessage({ phoneNumberId: 'phone-1', accessToken: 'token-1', fetchImpl }, '919876543210', 'You are booked.');

  assert.equal(result.externalMessageId, 'wamid.OUT1');
  assert.match(capturedUrl!, /\/phone-1\/messages$/);
  assert.deepEqual(capturedBody, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'text', text: { body: 'You are booked.' } });
});

test('AU: sends a template message as a structurally distinct request from a session message', async () => {
  let capturedBody: unknown;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT2' }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new WhatsAppCloudProvider();
  await provider.sendTemplateMessage({ phoneNumberId: 'phone-1', accessToken: 'token-1', fetchImpl }, '919876543210', { name: 'appointment_confirmation', languageCode: 'en', bodyParameters: ['Dr Deepthi', '2026-08-13'] });

  assert.equal((capturedBody as { type: string }).type, 'template');
  assert.deepEqual((capturedBody as { template: { name: string } }).template.name, 'appointment_confirmation');
});

test('a 4xx response (e.g. rejected template) is non-retryable', async () => {
  const provider = new WhatsAppCloudProvider();
  await assert.rejects(
    provider.sendSessionMessage({ phoneNumberId: 'phone-1', accessToken: 'x', fetchImpl: fakeFetch(400, { error: { message: 'bad recipient' } }) }, '1', 'x'),
    (error: unknown) => error instanceof OutboundSendFailedError && error.retryable === false,
  );
});

test('a 5xx response is retryable', async () => {
  const provider = new WhatsAppCloudProvider();
  await assert.rejects(
    provider.sendSessionMessage({ phoneNumberId: 'phone-1', accessToken: 'x', fetchImpl: fakeFetch(503, {}) }, '1', 'x'),
    (error: unknown) => error instanceof OutboundSendFailedError && error.retryable === true,
  );
});

test('a 429 (rate limit) response is retryable', async () => {
  const provider = new WhatsAppCloudProvider();
  await assert.rejects(
    provider.sendSessionMessage({ phoneNumberId: 'phone-1', accessToken: 'x', fetchImpl: fakeFetch(429, {}) }, '1', 'x'),
    (error: unknown) => error instanceof OutboundSendFailedError && error.retryable === true,
  );
});

test('a network-level failure is retryable', async () => {
  const throwingFetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const provider = new WhatsAppCloudProvider();
  await assert.rejects(
    provider.sendSessionMessage({ phoneNumberId: 'phone-1', accessToken: 'x', fetchImpl: throwingFetch }, '1', 'x'),
    (error: unknown) => error instanceof OutboundSendFailedError && error.retryable === true,
  );
});

test('AD: the access token never appears anywhere except the Authorization header', async () => {
  let capturedHeaders: Record<string, string> | undefined;
  let capturedBody: string | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    capturedHeaders = init.headers as Record<string, string>;
    capturedBody = init.body as string;
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new WhatsAppCloudProvider();
  await provider.sendSessionMessage({ phoneNumberId: 'phone-1', accessToken: 'super-secret-token-value', fetchImpl }, '1', 'hello');

  assert.equal(capturedHeaders!.authorization, 'Bearer super-secret-token-value');
  assert.doesNotMatch(capturedBody!, /super-secret-token-value/);
});
