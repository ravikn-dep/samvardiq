import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { PostgresCommunicationChannelRepository } from '../../src/postgres/channelRepository.js';
import { PostgresConversationRepository, PostgresMessageRepository } from '../../src/postgres/conversationRepository.js';
import { PostgresMessageContentRepository } from '../../src/postgres/messageContentRepository.js';
import { PostgresWebhookEventDedupRepository } from '../../src/postgres/webhookDedupRepository.js';
import { pgErrorCode, withOrganizationContext } from '../../src/postgres/client.js';
import { conversations } from '../../src/postgres/schema.js';
import { computePurgeAfter } from '../../src/retention.js';
import type { CommunicationChannel, Conversation } from '../../src/types.js';
import { startHarness, type Harness } from './harness.js';

/** R/Q/S/T/BK-class adversarial matrix — proven against real, disposable PostgreSQL. */

const PORT = 55801;
let harness: Harness;
let channels: PostgresCommunicationChannelRepository;
let convRepo: PostgresConversationRepository;
let messages: PostgresMessageRepository;
let content: PostgresMessageContentRepository;
let dedup: PostgresWebhookEventDedupRepository;

before(async () => {
  harness = await startHarness(PORT);
  channels = new PostgresCommunicationChannelRepository(harness.app.db);
  convRepo = new PostgresConversationRepository(harness.app.db);
  messages = new PostgresMessageRepository(harness.app.db);
  content = new PostgresMessageContentRepository(harness.app.db);
  dedup = new PostgresWebhookEventDedupRepository(harness.app.db);
}, { timeout: 60_000 });

after(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.truncateAll();
});

function channel(overrides: Partial<CommunicationChannel> = {}): CommunicationChannel {
  return {
    channelId: 'chan-1',
    organizationId: 'org-A',
    provider: 'meta_whatsapp_cloud_api',
    externalChannelId: 'phone-1',
    serviceIdentityId: 'svc-1',
    serviceProviderSubject: 'chan-1',
    accessTokenReference: 'env:X',
    displayPhoneNumber: '+911234567890',
    timezone: 'Asia/Kolkata',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: 'conv-1',
    organizationId: 'org-A',
    channelId: 'chan-1',
    externalContactId: '919876543210',
    state: 'AI_ACTIVE',
    preferredLanguage: 'en-IN',
    bookingState: 'NEW',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('a channel can be resolved by external_channel_id without any organization context (platform-global, by design)', async () => {
  await channels.create(channel());
  const found = await channels.getEnabledByExternalChannelId('phone-1');
  assert.equal(found?.organizationId, 'org-A');
});

test('a duplicate external_channel_id is rejected at the database level (uniqueness, not RLS, is what keeps the platform-global lookup safe)', async () => {
  await channels.create(channel());
  await assert.rejects(channels.create(channel({ channelId: 'chan-2', organizationId: 'org-B' })), (error: unknown) => pgErrorCode(error) === '23505');
});

test('R/Q: Org A cannot read Org B`s conversations, and no organization context sees zero rows', async () => {
  await convRepo.create(conversation({ organizationId: 'org-A', conversationId: 'conv-A' }));
  await convRepo.create(conversation({ organizationId: 'org-B', conversationId: 'conv-B', externalContactId: '910000000000' }));

  const forA = await convRepo.getByExternalContact('org-A', 'chan-1', '919876543210');
  const forB = await convRepo.getByExternalContact('org-B', 'chan-1', '910000000000');
  assert.equal(forA?.conversationId, 'conv-A');
  assert.equal(forB?.conversationId, 'conv-B');

  const noContext = await harness.app.db.select().from(conversations);
  assert.equal(noContext.length, 0, 'no session context means RLS must hide every row, never expose all of them');
});

test('S: a cross-organization conversation insert is rejected by the write policy', async () => {
  await assert.rejects(async () => {
    await withOrganizationContext(harness.app.db, 'org-A', async (tx) => {
      await tx.insert(conversations).values({
        organizationId: 'org-B',
        conversationId: 'conv-cross',
        channelId: 'chan-1',
        externalContactId: '910000000000',
        state: 'AI_ACTIVE',
        preferredLanguage: 'en-IN',
        bookingState: 'NEW',
      });
    });
  }, (error: unknown) => pgErrorCode(error) === '42501' || /row-level security/i.test(String(error)));
});

test('BK: concurrent Org A / Org B message writes remain isolated', async () => {
  await Promise.all([
    messages.record({ messageId: 'm-A', organizationId: 'org-A', conversationId: 'conv-A', direction: 'INBOUND', messageType: 'text', createdAt: new Date().toISOString() }),
    messages.record({ messageId: 'm-B', organizationId: 'org-B', conversationId: 'conv-B', direction: 'INBOUND', messageType: 'text', createdAt: new Date().toISOString() }),
  ]);
  const forA = await messages.listByConversation('org-A', 'conv-A');
  const forB = await messages.listByConversation('org-B', 'conv-B');
  assert.equal(forA.length, 1);
  assert.equal(forB.length, 1);
  assert.notEqual(forA[0]!.messageId, forB[0]!.messageId);
});

test('AA/AB: raw message content is organization-isolated and never readable across organizations', async () => {
  await content.record({ organizationId: 'org-A', messageId: 'm-A', rawText: 'patient text for org A', purgeAfter: computePurgeAfter() });
  await content.record({ organizationId: 'org-B', messageId: 'm-B', rawText: 'patient text for org B', purgeAfter: computePurgeAfter() });

  const forA = await content.get('org-A', 'm-A');
  const crossRead = await content.get('org-A', 'm-B');
  assert.equal(forA?.rawText, 'patient text for org A');
  assert.equal(crossRead, null, 'Org A must never read Org B`s raw message content, even by guessing the message id');
});

test('X/Y: expired raw message content is purged; unexpired content survives', async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = computePurgeAfter();
  await content.record({ organizationId: 'org-A', messageId: 'm-expired', rawText: 'old', purgeAfter: past });
  await content.record({ organizationId: 'org-A', messageId: 'm-fresh', rawText: 'new', purgeAfter: future });

  const purgedCount = await content.purgeExpired('org-A');
  assert.equal(purgedCount, 1);
  assert.equal(await content.get('org-A', 'm-expired'), null);
  assert.notEqual(await content.get('org-A', 'm-fresh'), null);
});

test('U/V: a provider event is deduplicated — the second reservation attempt for the same id fails', async () => {
  const first = await dedup.reserve('meta_whatsapp_cloud_api', 'wamid-1');
  const second = await dedup.reserve('meta_whatsapp_cloud_api', 'wamid-1');
  assert.equal(first, true);
  assert.equal(second, false);
});

test('a conversation update persists booking-state progress and is re-readable', async () => {
  await convRepo.create(conversation());
  const updated = await convRepo.update({ ...conversation(), bookingState: 'BOOKED', activeAppointmentId: 'APT-1', updatedAt: new Date().toISOString() });
  assert.equal(updated.bookingState, 'BOOKED');
  const reread = await convRepo.getById('org-A', 'conv-1');
  assert.equal(reread?.activeAppointmentId, 'APT-1');
});
