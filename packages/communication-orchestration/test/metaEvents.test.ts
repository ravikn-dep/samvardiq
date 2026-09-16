import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MalformedProviderPayloadError } from '../src/errors.js';
import { parseMetaWebhookEvents } from '../src/metaEvents.js';

function envelope(value: unknown): string {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba-1', changes: [{ field: 'messages', value }] }] });
}

test('C: extracts a text message event with the phone_number_id, contact id, wamid, and body', () => {
  const events = parseMetaWebhookEvents(
    envelope({
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'phone-1', display_phone_number: '911234567890' },
      contacts: [{ profile: { name: 'Anita Rao' }, wa_id: '919876543210' }],
      messages: [{ from: '919876543210', id: 'wamid.ABC', timestamp: '1700000000', type: 'text', text: { body: 'book appointment' } }],
    }),
  );
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.type, 'text');
  if (event.type === 'text') {
    assert.equal(event.externalChannelId, 'phone-1');
    assert.equal(event.externalContactId, '919876543210');
    assert.equal(event.externalMessageId, 'wamid.ABC');
    assert.equal(event.text, 'book appointment');
    assert.equal(event.contactDisplayName, 'Anita Rao');
  }
});

test('D: extracts a status callback event', () => {
  const events = parseMetaWebhookEvents(
    envelope({ metadata: { phone_number_id: 'phone-1' }, statuses: [{ id: 'wamid.ABC', status: 'delivered', timestamp: '1700000001', recipient_id: '919876543210' }] }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'status');
});

test('W: multiple entries/changes/messages in one delivery all produce events, none dropped', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      { id: 'waba-1', changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages: [{ from: 'a', id: 'wamid.1', type: 'text', text: { body: 'x' } }] } }] },
      { id: 'waba-1', changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages: [{ from: 'b', id: 'wamid.2', type: 'text', text: { body: 'y' } }] } }] },
    ],
  };
  const events = parseMetaWebhookEvents(JSON.stringify(payload));
  assert.equal(events.length, 2);
});

test('an unsupported message type becomes an "unsupported" event, never thrown or silently dropped', () => {
  const events = parseMetaWebhookEvents(envelope({ metadata: { phone_number_id: 'phone-1' }, messages: [{ from: '919876543210', id: 'wamid.IMG', type: 'image' }] }));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'unsupported');
});

test('malformed (non-JSON) payload fails closed with MalformedProviderPayloadError', () => {
  assert.throws(() => parseMetaWebhookEvents('not json'), MalformedProviderPayloadError);
});

test('a payload missing the expected envelope shape fails closed', () => {
  assert.throws(() => parseMetaWebhookEvents(JSON.stringify({ object: 'something_else' })), MalformedProviderPayloadError);
  assert.throws(() => parseMetaWebhookEvents(JSON.stringify({ object: 'whatsapp_business_account' })), MalformedProviderPayloadError);
});

test('an entry with no phone_number_id contributes no events, rather than guessing one', () => {
  const events = parseMetaWebhookEvents(envelope({ messages: [{ from: 'a', id: 'wamid.1', type: 'text', text: { body: 'x' } }] }));
  assert.equal(events.length, 0);
});
