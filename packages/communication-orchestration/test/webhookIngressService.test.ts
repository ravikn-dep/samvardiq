import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { AuthorizationService, InMemoryIdentityProviderLinkRepository, InMemoryIdentityRepository, InMemoryMembershipRepository } from '@samvardiq/identity-access';
import { InMemoryOrganizationRepository } from '@samvardiq/data-foundation';
import { EnvConnectorSecretProvider, InMemoryClinicCmsConnectionRepository, InMemoryConnectorAuditRepository, type ClinicOperationsConnector } from '@samvardiq/clinic-cms-connector';
import type { ClinicOperationsDependencies } from '@samvardiq/application-services';

import { InMemoryCommunicationChannelRepository } from '../src/channelRepository.js';
import { DeterministicCommunicationInterpreter } from '../src/communicationInterpreter.js';
import { InMemoryConversationRepository, InMemoryMessageRepository } from '../src/conversationRepository.js';
import { InMemoryMessageContentRepository } from '../src/messageContentRepository.js';
import { provisionCommunicationChannel } from '../src/provisioning.js';
import { InvalidWebhookSignatureError } from '../src/errors.js';
import { processWhatsAppWebhook, type WebhookIngressDependencies } from '../src/webhookIngressService.js';
import { InMemoryWebhookEventDedupRepository } from '../src/webhookDedupRepository.js';

const APP_SECRET = 'reference-app-secret-value-at-least-32-chars';
const platformAppSecretReference = 'env:META_APP_SECRET';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function textPayload(text: string, messageId = 'wamid.1'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, contacts: [{ wa_id: '919876543210', profile: { name: 'Anita' } }], messages: [{ from: '919876543210', id: messageId, type: 'text', text: { body: text } }] } }] }],
  });
}

class NoopConnector implements ClinicOperationsConnector {
  async checkHealth() { return { status: 'ok' as const }; }
  async listConsultants() { return []; }
  async getAvailableSlots() { return { externalConsultantId: '7', date: '2026-08-13', timezone: 'Asia/Kolkata', slots: [] }; }
  async findPatients() { return []; }
  async registerPatient(): Promise<never> { throw new Error('not used'); }
  async createEnquiry(): Promise<never> { throw new Error('not used'); }
  async createAppointment(): Promise<never> { throw new Error('not used'); }
  async getAppointment(): Promise<never> { throw new Error('not used'); }
  async rescheduleAppointment(): Promise<never> { throw new Error('not used'); }
  async cancelAppointment(): Promise<never> { throw new Error('not used'); }
}

async function buildWorld(): Promise<WebhookIngressDependencies & { messages: InMemoryMessageRepository }> {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  const organizations = new InMemoryOrganizationRepository();
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });
  const channels = new InMemoryCommunicationChannelRepository();
  await provisionCommunicationChannel(
    { identities, providerLinks, memberships, channels },
    { channelId: 'chan-1', organizationId: 'org-A', externalChannelId: 'phone-1', displayPhoneNumber: '+911234567890', timezone: 'Asia/Kolkata', accessTokenReference: 'env:TOKEN' },
  );

  const clinicDeps: ClinicOperationsDependencies = {
    identityProvider: undefined as never,
    authz,
    organizations,
    clinicConnections: new InMemoryClinicCmsConnectionRepository(),
    clinicSecrets: new EnvConnectorSecretProvider({ TOKEN: 'x', CLINIC_SECRET: 'clinic-secret-at-least-32-characters' }),
    clinicConnectorAudit: new InMemoryConnectorAuditRepository(),
    createClinicConnector: () => new NoopConnector(),
  };
  await clinicDeps.clinicConnections.create({
    connectionId: 'conn-1',
    organizationId: 'org-A',
    baseUrl: 'https://clinic.example.com',
    keyId: 'key-1',
    secretReference: 'env:CLINIC_SECRET',
    approvedScopes: [],
    timezone: 'Asia/Kolkata',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const messages = new InMemoryMessageRepository();
  return {
    authz,
    channels,
    appSecrets: new EnvConnectorSecretProvider({ META_APP_SECRET: APP_SECRET }),
    platformAppSecretReference,
    dedup: new InMemoryWebhookEventDedupRepository(),
    clinicDeps,
    conversations: new InMemoryConversationRepository(),
    messages,
    messageContent: new InMemoryMessageContentRepository(),
    interpreter: new DeterministicCommunicationInterpreter(),
    provider: { sendSessionMessage: async () => ({ externalMessageId: 'wamid.out' }), sendTemplateMessage: async () => ({ externalMessageId: 'wamid.out' }) },
    accessTokenSecrets: new EnvConnectorSecretProvider({ TOKEN: 'x' }),
  };
}

test('B: an invalid signature is rejected before any event is processed', async () => {
  const deps = await buildWorld();
  const body = textPayload('hello');
  await assert.rejects(processWhatsAppWebhook(deps, body, sign(body) + 'x'), InvalidWebhookSignatureError);
});

test('U/V: a duplicate provider event (same wamid) is processed at most once', async () => {
  const deps = await buildWorld();
  const body = textPayload('hello there', 'wamid.dup');

  await processWhatsAppWebhook(deps, body, sign(body));
  await processWhatsAppWebhook(deps, body, sign(body)); // exact redelivery

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876543210');
  const stored = await deps.messages.listByConversation('org-A', conversation!.conversationId);
  assert.equal(stored.length, 1, 'the duplicate delivery must not be processed a second time');
});

test('a text event reaches the conversation/message layer end to end through the real ingress path', async () => {
  const deps = await buildWorld();
  const body = textPayload('hello there', 'wamid.new');
  await processWhatsAppWebhook(deps, body, sign(body));

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876543210');
  assert.ok(conversation);
  assert.equal(conversation!.state, 'AI_ACTIVE');
});
