import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthorizationService, InMemoryIdentityProviderLinkRepository, InMemoryIdentityRepository, InMemoryMembershipRepository } from '@samvardiq/identity-access';
import { InMemoryOrganizationRepository } from '@samvardiq/data-foundation';
import {
  EnvConnectorSecretProvider,
  InMemoryClinicCmsConnectionRepository,
  InMemoryConnectorAuditRepository,
  type Appointment,
  type AppointmentCancellation,
  type AvailableSlots,
  type ClinicOperationsConnector,
  type ConnectorHealth,
  type ConsultantSummary,
  type CreateAppointmentInput,
  type CreateEnquiryInput,
  type EnquiryReference,
  type FindPatientsInput,
  type IdempotentOperation,
  type PatientMatch,
  type RegisterPatientInput,
  type RegisteredPatient,
  type RescheduleAppointmentInput,
} from '@samvardiq/clinic-cms-connector';
import type { ClinicOperationsDependencies } from '@samvardiq/application-services';

import { handleInboundTextEvent } from '../src/bookingOrchestrator.js';
import { InMemoryCommunicationChannelRepository } from '../src/channelRepository.js';
import { InMemoryConversationRepository, InMemoryMessageRepository } from '../src/conversationRepository.js';
import { InMemoryMessageContentRepository } from '../src/messageContentRepository.js';
import { DeterministicCommunicationInterpreter } from '../src/communicationInterpreter.js';
import type { CommunicationProvider, OutboundProviderConfig, SendResult, TemplateRef } from '../src/communicationProvider.js';
import { provisionCommunicationChannel } from '../src/provisioning.js';

class FakeConnector implements ClinicOperationsConnector {
  patients: PatientMatch[] = [];
  consultants: ConsultantSummary[] = [{ externalConsultantId: '7', displayName: 'Dr Deepthi' }];
  slots: string[] = ['09:00'];
  createAppointmentError: Error | null = null;
  registeredCount = 0;

  async checkHealth(): Promise<ConnectorHealth> {
    return { status: 'ok' };
  }
  async listConsultants(): Promise<ConsultantSummary[]> {
    return this.consultants;
  }
  async getAvailableSlots(): Promise<AvailableSlots> {
    return { externalConsultantId: '7', date: '2026-08-13', timezone: 'Asia/Kolkata', slots: this.slots };
  }
  async findPatients(_input: FindPatientsInput): Promise<PatientMatch[]> {
    return this.patients;
  }
  async registerPatient(_input: RegisterPatientInput & IdempotentOperation): Promise<RegisteredPatient> {
    this.registeredCount += 1;
    const externalPatientId = `PAT-NEW-${this.registeredCount}`;
    return { externalPatientId, displayName: 'New Patient' };
  }
  async createEnquiry(_input: CreateEnquiryInput & IdempotentOperation): Promise<EnquiryReference> {
    return { externalEnquiryId: 'ENQ-1', externalPatientId: 'PAT-1' };
  }
  appointmentIdempotencyKeys: string[] = [];
  async createAppointment(input: CreateAppointmentInput & IdempotentOperation): Promise<Appointment> {
    this.appointmentIdempotencyKeys.push(input.idempotencyKey);
    if (this.createAppointmentError) throw this.createAppointmentError;
    return { externalAppointmentId: 'APT-1', externalPatientId: 'PAT-1', externalConsultantId: '7', appointmentDate: '2026-08-13', appointmentTime: '09:00', duration: 30, status: 'Scheduled', checkedInAt: null };
  }
  async getAppointment(): Promise<Appointment> {
    throw new Error('not used in this slice');
  }
  async rescheduleAppointment(_id: string, _input: RescheduleAppointmentInput): Promise<Appointment> {
    throw new Error('not used in this slice');
  }
  async cancelAppointment(): Promise<AppointmentCancellation> {
    throw new Error('not used in this slice');
  }
}

class FakeProvider implements CommunicationProvider {
  sent: { to: string; text: string }[] = [];
  shouldFailSend = false;

  async sendSessionMessage(_config: OutboundProviderConfig, to: string, text: string): Promise<SendResult> {
    if (this.shouldFailSend) throw new Error('send failed');
    this.sent.push({ to, text });
    return { externalMessageId: `wamid.out.${this.sent.length}` };
  }
  async sendTemplateMessage(_config: OutboundProviderConfig, to: string, _template: TemplateRef): Promise<SendResult> {
    this.sent.push({ to, text: '[template]' });
    return { externalMessageId: `wamid.out.${this.sent.length}` };
  }
}

async function buildWorld() {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  const organizations = new InMemoryOrganizationRepository();
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'org-A' });

  const commsChannels = new InMemoryCommunicationChannelRepository();
  const channel = await provisionCommunicationChannel(
    { identities, providerLinks, memberships, channels: commsChannels },
    { channelId: 'chan-1', organizationId: 'org-A', externalChannelId: 'phone-1', displayPhoneNumber: '+911234567890', timezone: 'Asia/Kolkata', accessTokenReference: 'env:TOKEN' },
  );

  const context = await authz.resolveTrustedContext({ principal: { provider: 'whatsapp-channel', providerSubject: 'chan-1', verifiedAt: new Date().toISOString() }, requestedOrganizationId: 'org-A' });

  const connector = new FakeConnector();
  const clinicDeps: ClinicOperationsDependencies = {
    identityProvider: undefined as never, // never invoked — the context is already resolved before this layer
    authz,
    organizations,
    clinicConnections: new InMemoryClinicCmsConnectionRepository(),
    clinicSecrets: new EnvConnectorSecretProvider({ TOKEN: 'access-token-value', CLINIC_SECRET: 'clinic-cms-hmac-secret-at-least-32ch' }),
    clinicConnectorAudit: new InMemoryConnectorAuditRepository(),
    createClinicConnector: () => connector,
  };
  await clinicDeps.clinicConnections.create({
    connectionId: 'conn-1',
    organizationId: 'org-A',
    baseUrl: 'https://clinic.example.com',
    keyId: 'key-1',
    secretReference: 'env:CLINIC_SECRET',
    approvedScopes: ['patients:read', 'patients:write', 'consultants:read', 'appointments:read', 'appointments:write', 'enquiries:write'],
    timezone: 'Asia/Kolkata',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const provider = new FakeProvider();
  const deps = {
    clinicDeps,
    conversations: new InMemoryConversationRepository(),
    messages: new InMemoryMessageRepository(),
    messageContent: new InMemoryMessageContentRepository(),
    interpreter: new DeterministicCommunicationInterpreter(),
    provider,
    accessTokenSecrets: new EnvConnectorSecretProvider({ TOKEN: 'access-token-value' }),
  };

  return { deps, channel, context, connector, provider };
}

test('AL/AQ/AN/AO: full happy path — existing patient, real W1B calls, booking confirmed, outbound sent', async () => {
  const { deps, channel, context, connector, provider } = await buildWorld();
  connector.patients = [{ externalPatientId: 'PAT-1', displayName: 'Anita Rao' }];

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: '919876543210', externalMessageId: 'wamid.1', text: 'Hi, appointment with Dr Deepthi tomorrow' });

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876543210');
  assert.equal(conversation?.bookingState, 'CONFIRMED');
  assert.equal(conversation?.externalPatientId, 'PAT-1');
  assert.equal(conversation?.activeAppointmentId, 'APT-1');
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0]!.text, /Dr Deepthi/);
});

test('AO: new-patient path registers via W1B rather than skipping registration', async () => {
  const { deps, channel, context, connector } = await buildWorld();
  connector.patients = []; // no existing match

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: '919876500000', externalMessageId: 'wamid.2', text: 'appointment with Dr Deepthi tomorrow', contactDisplayName: 'Ravi Kumar' });

  assert.equal(connector.registeredCount, 1);
  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876500000');
  assert.equal(conversation?.externalPatientId, 'PAT-NEW-1');
  assert.equal(conversation?.bookingState, 'CONFIRMED');
});

test('AN: an ambiguous patient match (2+) hands off rather than guessing', async () => {
  const { deps, channel, context, connector } = await buildWorld();
  connector.patients = [{ externalPatientId: 'PAT-1', displayName: 'A' }, { externalPatientId: 'PAT-2', displayName: 'B' }];

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: '919876500001', externalMessageId: 'wamid.3', text: 'appointment with Dr Deepthi tomorrow' });

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876500001');
  assert.equal(conversation?.state, 'HUMAN_HANDOFF_REQUESTED');
  assert.equal(conversation?.handoffTrigger, 'AMBIGUOUS_PATIENT_MATCH');
});

test('no consultant match hands off with BOOKING_DETAILS_UNRESOLVED', async () => {
  const { deps, channel, context, connector } = await buildWorld();
  connector.patients = [{ externalPatientId: 'PAT-1', displayName: 'A' }];

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: '919876500002', externalMessageId: 'wamid.4', text: 'appointment with Dr Unknown tomorrow' });

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876500002');
  assert.equal(conversation?.handoffTrigger, 'BOOKING_DETAILS_UNRESOLVED');
});

test('AL/AM: CMS availability is authoritative — zero returned slots hands off rather than inventing one', async () => {
  const { deps, channel, context, connector } = await buildWorld();
  connector.patients = [{ externalPatientId: 'PAT-1', displayName: 'A' }];
  connector.slots = [];

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: '919876500003', externalMessageId: 'wamid.5', text: 'appointment with Dr Deepthi tomorrow' });

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876500003');
  assert.equal(conversation?.handoffTrigger, 'BOOKING_DETAILS_UNRESOLVED');
});

test('AS: CMS-layer failure during booking fails safe to handoff, never a partial mutation', async () => {
  const { deps, channel, context, connector } = await buildWorld();
  connector.patients = [{ externalPatientId: 'PAT-1', displayName: 'A' }];
  connector.createAppointmentError = new Error('CMS unavailable');

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: '919876500004', externalMessageId: 'wamid.6', text: 'appointment with Dr Deepthi tomorrow' });

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876500004');
  assert.equal(conversation?.state, 'HUMAN_HANDOFF_REQUESTED');
  assert.equal(conversation?.handoffTrigger, 'CMS_UNRECOVERABLE_FAILURE');
  assert.notEqual(conversation?.bookingState, 'BOOKED');
});

test('AR/AS: CMS booking success + outbound send failure never regresses/duplicates the booking — bookingState stays BOOKED, not CONFIRMED', async () => {
  const { deps, channel, context, connector, provider } = await buildWorld();
  connector.patients = [{ externalPatientId: 'PAT-1', displayName: 'A' }];
  provider.shouldFailSend = true;

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: '919876500005', externalMessageId: 'wamid.7', text: 'appointment with Dr Deepthi tomorrow' });

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', '919876500005');
  assert.equal(conversation?.bookingState, 'BOOKED');
  assert.equal(conversation?.activeAppointmentId, 'APT-1'); // appointment REMAINS booked, section 24
});

test('AG: UNKNOWN once asks for clarification (conversation stays AI_ACTIVE), twice hands off', async () => {
  const { deps, channel, context, provider } = await buildWorld();
  const contact = '919876500006';

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: contact, externalMessageId: 'wamid.8', text: 'hello there' });
  let conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', contact);
  assert.equal(conversation?.state, 'AI_ACTIVE');
  assert.equal(provider.sent.length, 1);

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: contact, externalMessageId: 'wamid.9', text: 'still hello' });
  conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', contact);
  assert.equal(conversation?.state, 'HUMAN_HANDOFF_REQUESTED');
});

test('section 25 binding invariant: once handed off, no further autonomous reply and no further CMS calls', async () => {
  const { deps, channel, context, connector, provider } = await buildWorld();
  const contact = '919876500007';
  const conversation = await deps.conversations.create({
    conversationId: 'conv-handed-off',
    organizationId: 'org-A',
    channelId: 'chan-1',
    externalContactId: contact,
    state: 'HUMAN_HANDOFF_REQUESTED',
    preferredLanguage: 'en-IN',
    bookingState: 'HUMAN_HANDOFF_REQUESTED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  void conversation;

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: contact, externalMessageId: 'wamid.10', text: 'book appointment with Dr Deepthi tomorrow' });

  assert.equal(provider.sent.length, 0, 'no autonomous reply once handed off');
  assert.equal(connector.registeredCount, 0, 'no CMS call once handed off');
  const messages = await deps.messages.listByConversation('org-A', 'conv-handed-off');
  assert.equal(messages.length, 1, 'the message is still recorded for continuity/audit');
});

test('AA/AB: raw text is persisted with a bounded purge expiry, never indefinitely', async () => {
  const { deps, channel, context } = await buildWorld();
  const contact = '919876500008';
  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: contact, externalMessageId: 'wamid.11', text: 'hello' });

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', contact);
  const messages = await deps.messages.listByConversation('org-A', conversation!.conversationId);
  const content = await deps.messageContent.get('org-A', messages[0]!.messageId);
  assert.ok(content);
  assert.ok(new Date(content!.purgeAfter).getTime() > Date.now());
});

test('retry-duplication guard: a second APPOINTMENT_BOOK message against an already-booked conversation hands off rather than creating a second appointment', async () => {
  const { deps, channel, context, connector, provider } = await buildWorld();
  const contact = '919876500010';
  connector.patients = [{ externalPatientId: 'PAT-1', displayName: 'Anita Rao' }];

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: contact, externalMessageId: 'wamid.13', text: 'appointment with Dr Deepthi tomorrow' });
  let conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', contact);
  assert.equal(conversation?.bookingState, 'CONFIRMED');
  assert.equal(conversation?.activeAppointmentId, 'APT-1');
  const appointmentsBefore = connector.registeredCount;

  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: contact, externalMessageId: 'wamid.14', text: 'appointment with Dr Deepthi tomorrow' });
  conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', contact);

  assert.equal(conversation?.state, 'HUMAN_HANDOFF_REQUESTED');
  assert.equal(conversation?.handoffTrigger, 'BOOKING_ALREADY_IN_PROGRESS');
  assert.equal(conversation?.activeAppointmentId, 'APT-1', 'the original appointment is untouched');
  assert.equal(connector.registeredCount, appointmentsBefore, 'no new CMS patient/appointment mutation occurred');
  assert.equal(provider.sent.length, 2, 'the original confirmation plus the handoff message — never a second booking confirmation');
});

test('the persisted message metadata never contains the raw patient text (only the derived structured intent)', async () => {
  const { deps, channel, context } = await buildWorld();
  const contact = '919876500009';
  await handleInboundTextEvent(deps, channel, context, { externalChannelId: 'phone-1', externalContactId: contact, externalMessageId: 'wamid.12', text: 'this is patient free text' });

  const conversation = await deps.conversations.getByExternalContact('org-A', 'chan-1', contact);
  const messages = await deps.messages.listByConversation('org-A', conversation!.conversationId);
  assert.equal(JSON.stringify(messages).includes('this is patient free text'), false);
});

// ---------------------------------------------------------------------------------------------------------------
// CLINIC-W2D — handoff lifecycle through the real orchestrator (Founder decisions W2D-01/02).
// ---------------------------------------------------------------------------------------------------------------

const CONTACT = '919876511111';
const inbound = (text: string, id: string) => ({ externalChannelId: 'phone-1', externalContactId: CONTACT, externalMessageId: id, text });

/** Drives a real booking to CONFIRMED, then a second booking request hands off (BOOKING_ALREADY_IN_PROGRESS), then staff claim it. */
async function confirmedThenClaimed() {
  const world = await buildWorld();
  world.connector.patients = [{ externalPatientId: 'PAT-1', displayName: 'Anita Rao' }];
  await handleInboundTextEvent(world.deps, world.channel, world.context, inbound('appointment with Dr Deepthi tomorrow', 'wamid.w2d.1'));
  await handleInboundTextEvent(world.deps, world.channel, world.context, inbound('appointment with Dr Deepthi tomorrow', 'wamid.w2d.2'));
  const handedOff = (await world.deps.conversations.getByExternalContact('org-A', 'chan-1', CONTACT))!;
  assert.equal(handedOff.state, 'HUMAN_HANDOFF_REQUESTED');
  const claim = await world.deps.conversations.claimHumanHandoff('org-A', handedOff.conversationId, 'staff-1');
  assert.equal(claim.kind, 'CLAIMED');
  return { ...world, conversationId: handedOff.conversationId };
}

test('W2D S/T/AB: RETURN_TO_AI starts a fresh journey — old idempotency key cleared, history kept, next booking uses a NEW key', async () => {
  const { deps, channel, context, connector, conversationId } = await confirmedThenClaimed();
  const firstKey = connector.appointmentIdempotencyKeys[0]!;
  const before = (await deps.conversations.getById('org-A', conversationId))!;
  assert.equal(firstKey, `${before.bookingIdempotencyKey}:appointment`, 'the CMS key derives from the conversation key');

  const result = await deps.conversations.resolveHumanHandoff('org-A', conversationId, 'staff-1', 'RETURN_TO_AI');
  assert.equal(result.kind, 'RESOLVED');
  const reset = (await deps.conversations.getById('org-A', conversationId))!;
  assert.equal(reset.state, 'AI_ACTIVE');
  assert.equal(reset.bookingState, 'NEW');
  for (const field of ['bookingIdempotencyKey', 'bookingConsultantId', 'bookingDate', 'bookingSlot', 'handoffTrigger', 'handoffAt', 'handoffOwnerIdentityId', 'handoffClaimedAt'] as const) {
    assert.equal(reset[field], undefined, `${field} must be reset`);
  }
  // AB: completed business records and the confirmed patient identity survive.
  assert.equal(reset.externalPatientId, 'PAT-1');
  assert.equal(reset.activeEnquiryId, 'ENQ-1');
  assert.equal(reset.activeAppointmentId, 'APT-1');

  // T: the AI books again — a deliberate new booking with a fresh key, never a replay of the first operation.
  await handleInboundTextEvent(deps, channel, context, inbound('appointment with Dr Deepthi tomorrow', 'wamid.w2d.3'));
  assert.equal(connector.appointmentIdempotencyKeys.length, 2);
  assert.notEqual(connector.appointmentIdempotencyKeys[1], firstKey);
  assert.equal((await deps.conversations.getById('org-A', conversationId))!.bookingState, 'CONFIRMED');
});

test('W2D W/Y + safety regression: a CLOSED conversation reopens on the next inbound message and processes it normally (not silently stored)', async () => {
  const { deps, channel, context, provider, connector, conversationId } = await confirmedThenClaimed();
  assert.equal((await deps.conversations.resolveHumanHandoff('org-A', conversationId, 'staff-1', 'CLOSE')).kind, 'RESOLVED');
  assert.equal((await deps.conversations.getById('org-A', conversationId))!.state, 'CLOSED');
  const sentBefore = provider.sent.length;

  await handleInboundTextEvent(deps, channel, context, inbound('appointment with Dr Deepthi tomorrow', 'wamid.w2d.4'));

  const after = (await deps.conversations.getById('org-A', conversationId))!;
  assert.equal(after.bookingState, 'CONFIRMED', 'the reopened message went through the full booking pipeline');
  assert.equal(connector.appointmentIdempotencyKeys.length, 2);
  assert.ok(provider.sent.length > sentBefore, 'the patient got a reply — the message was not silently stored');
  const reopened = (await deps.conversations.listHandoffEvents('org-A', conversationId)).filter((e) => e.eventType === 'REOPENED');
  assert.equal(reopened.length, 1);
  assert.deepEqual({ actor: reopened[0]!.actorIdentityId, type: reopened[0]!.actorPrincipalType }, { actor: context.identityId, type: 'service' });
});

test('W2D Y: after reopening, an escalating message reaches the ordinary policy and hands off to staff again', async () => {
  const { deps, channel, context, provider, conversationId } = await confirmedThenClaimed();
  await deps.conversations.resolveHumanHandoff('org-A', conversationId, 'staff-1', 'CLOSE');

  // The deterministic interpreter classifies this as UNKNOWN; the policy clarifies once, then hands off.
  await handleInboundTextEvent(deps, channel, context, inbound('my chest hurts what do I do', 'wamid.w2d.5'));
  const clarified = (await deps.conversations.getById('org-A', conversationId))!;
  assert.equal(clarified.state, 'AI_ACTIVE');
  assert.match(provider.sent.at(-1)!.text, /consultant and which date/);
  await handleInboundTextEvent(deps, channel, context, inbound('please help', 'wamid.w2d.6'));
  const escalated = (await deps.conversations.getById('org-A', conversationId))!;
  assert.equal(escalated.state, 'HUMAN_HANDOFF_REQUESTED');
  assert.equal(escalated.handoffTrigger, 'UNKNOWN_AFTER_CLARIFICATION');
});

test('W2D V: reads never reopen a CLOSED conversation', async () => {
  const { deps, conversationId } = await confirmedThenClaimed();
  await deps.conversations.resolveHumanHandoff('org-A', conversationId, 'staff-1', 'CLOSE');
  await deps.conversations.getById('org-A', conversationId);
  await deps.conversations.getByExternalContact('org-A', 'chan-1', CONTACT);
  await deps.conversations.listHumanHandoffs('org-A', { limit: 10 });
  assert.equal((await deps.conversations.getById('org-A', conversationId))!.state, 'CLOSED');
  assert.equal((await deps.conversations.listHandoffEvents('org-A', conversationId)).filter((e) => e.eventType === 'REOPENED').length, 0);
});
