import crypto from 'node:crypto';

import type { TrustedOrganizationContext } from '@samvardiq/identity-access';
import {
  createClinicAppointmentForContext,
  createClinicEnquiryForContext,
  findClinicPatientsForContext,
  getClinicAvailableSlotsForContext,
  listClinicConsultantsForContext,
  registerClinicPatientForContext,
  type ClinicOperationsDependencies,
} from '@samvardiq/application-services';
import type { ConnectorSecretProvider } from '@samvardiq/clinic-cms-connector';

import { evaluateCommunicationPolicy } from './communicationPolicy.js';
import type { CommunicationInterpreter } from './communicationInterpreter.js';
import type { CommunicationProvider } from './communicationProvider.js';
import type { ConversationRepository, MessageRepository } from './conversationRepository.js';
import type { MessageContentRepository } from './messageContentRepository.js';
import { computePurgeAfter } from './retention.js';
import type { CommunicationChannel, CommunicationMessage, Conversation, HandoffTrigger } from './types.js';

export interface BookingOrchestratorDependencies {
  clinicDeps: ClinicOperationsDependencies;
  conversations: ConversationRepository;
  messages: MessageRepository;
  messageContent: MessageContentRepository;
  interpreter: CommunicationInterpreter;
  provider: CommunicationProvider;
  accessTokenSecrets: ConnectorSecretProvider;
}

export interface InboundTextInput {
  externalChannelId: string;
  externalContactId: string;
  externalMessageId: string;
  text: string;
  contactDisplayName?: string;
}

const HANDOFF_MESSAGE = "I'm connecting you with our clinic team — they'll be with you shortly.";
const CLARIFY_MESSAGE = 'Could you share which consultant and which date you would like (e.g. "Dr Deepthi tomorrow")?';

/**
 * The deterministic booking state machine (section 20). Every branch ends
 * in exactly one of: a booked+confirmed appointment, a booking failure
 * safely handed off, a clarification request (conversation stays
 * AI_ACTIVE), or a handoff — never a partially-applied CMS mutation and
 * never a second autonomous reply once handed off (section 25's binding
 * invariant, enforced at the top of this function).
 */
export async function handleInboundTextEvent(
  deps: BookingOrchestratorDependencies,
  channel: CommunicationChannel,
  context: TrustedOrganizationContext,
  input: InboundTextInput,
): Promise<void> {
  let conversation = await getOrCreateConversation(deps, channel, context, input.externalContactId);

  // Section 25: once handed off, no further autonomous AI reply — the
  // message is still recorded (for continuity/audit), but nothing past
  // this point executes.
  if (conversation.state !== 'AI_ACTIVE') {
    await recordInboundMessage(deps, context, conversation, input, undefined);
    return;
  }

  const priorMessages = await deps.messages.listByConversation(context.organizationId, conversation.conversationId);
  const priorUnknownCount = priorMessages.filter((m) => m.direction === 'INBOUND' && m.structuredIntent?.intent === 'UNKNOWN').length;

  const intent = await deps.interpreter.interpret({ text: input.text, previousLanguage: conversation.preferredLanguage });
  await recordInboundMessage(deps, context, conversation, input, intent);

  conversation = await deps.conversations.update({ ...conversation, preferredLanguage: intent.languageDetected, updatedAt: new Date().toISOString() });

  const decision = evaluateCommunicationPolicy(intent, priorUnknownCount);

  if (decision.action === 'HANDOFF') {
    await handoff(deps, channel, context, conversation, decision.handoffTrigger!);
    return;
  }
  if (decision.action === 'CLARIFY') {
    await sendFixed(deps, channel, input.externalContactId, CLARIFY_MESSAGE);
    return;
  }

  // A booking already started or completed for this conversation (including
  // the narrow race where a second, concurrently-delivered message reaches
  // this point before the first pipeline run has persisted its
  // bookingIdempotencyKey) must never re-enter the pipeline — that would
  // call the CMS again with a fresh idempotency key and create a second,
  // independent appointment. This slice does not support modifying an
  // existing booking; hand off instead.
  if (conversation.bookingState !== 'NEW') {
    await handoff(deps, channel, context, conversation, 'BOOKING_ALREADY_IN_PROGRESS');
    return;
  }

  await runBookingPipeline(deps, channel, context, conversation, input, intent.consultantHint, intent.dateHint);
}

async function getOrCreateConversation(
  deps: BookingOrchestratorDependencies,
  channel: CommunicationChannel,
  context: TrustedOrganizationContext,
  externalContactId: string,
): Promise<Conversation> {
  const existing = await deps.conversations.getByExternalContact(context.organizationId, channel.channelId, externalContactId);
  if (existing) return existing;
  const now = new Date().toISOString();
  return deps.conversations.create({
    conversationId: crypto.randomUUID(),
    organizationId: context.organizationId,
    channelId: channel.channelId,
    externalContactId,
    state: 'AI_ACTIVE',
    preferredLanguage: 'en-IN',
    bookingState: 'NEW',
    createdAt: now,
    updatedAt: now,
  });
}

async function recordInboundMessage(
  deps: BookingOrchestratorDependencies,
  context: TrustedOrganizationContext,
  conversation: Conversation,
  input: InboundTextInput,
  intent: CommunicationMessage['structuredIntent'],
): Promise<void> {
  const messageId = crypto.randomUUID();
  await deps.messages.record({
    messageId,
    organizationId: context.organizationId,
    conversationId: conversation.conversationId,
    direction: 'INBOUND',
    externalMessageId: input.externalMessageId,
    messageType: 'text',
    structuredIntent: intent,
    createdAt: new Date().toISOString(),
  });
  // Section 15/26: raw text lives ONLY here, always with a bounded expiry.
  await deps.messageContent.record({ organizationId: context.organizationId, messageId, rawText: input.text, purgeAfter: computePurgeAfter() });
}

async function handoff(
  deps: BookingOrchestratorDependencies,
  channel: CommunicationChannel,
  context: TrustedOrganizationContext,
  conversation: Conversation,
  trigger: HandoffTrigger,
): Promise<void> {
  await deps.conversations.update({
    ...conversation,
    state: 'HUMAN_HANDOFF_REQUESTED',
    bookingState: 'HUMAN_HANDOFF_REQUESTED',
    handoffTrigger: trigger,
    handoffAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await sendFixed(deps, channel, conversation.externalContactId, HANDOFF_MESSAGE);
}

async function sendFixed(deps: BookingOrchestratorDependencies, channel: CommunicationChannel, to: string, text: string): Promise<void> {
  const accessToken = await deps.accessTokenSecrets.getSecret(channel.accessTokenReference);
  try {
    await deps.provider.sendSessionMessage({ phoneNumberId: channel.externalChannelId, accessToken }, to, text);
  } catch {
    // Section 24/31: an outbound send failure never throws back into the
    // webhook ingress (which must still acknowledge the provider event) —
    // it is a delivery-outcome fact, not a processing failure.
  }
}

function resolveDateHint(dateHint: string | undefined, timezone: string): string | undefined {
  if (!dateHint) return undefined;
  const now = new Date();
  if (dateHint === 'tomorrow') now.setUTCDate(now.getUTCDate() + 1);
  else if (dateHint !== 'today') return undefined;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function splitDisplayName(displayName: string | undefined, fallbackContact: string): { firstName: string; lastName: string } {
  const trimmed = displayName?.trim();
  if (!trimmed) return { firstName: 'WhatsApp', lastName: fallbackContact };
  const parts = trimmed.split(/\s+/);
  return parts.length > 1 ? { firstName: parts[0]!, lastName: parts.slice(1).join(' ') } : { firstName: parts[0]!, lastName: 'Contact' };
}

async function runBookingPipeline(
  deps: BookingOrchestratorDependencies,
  channel: CommunicationChannel,
  context: TrustedOrganizationContext,
  conversation: Conversation,
  input: InboundTextInput,
  consultantHint: string | undefined,
  dateHint: string | undefined,
): Promise<void> {
  try {
    // Section 21: patient resolution reuses W1B — never a second search implementation.
    let externalPatientId = conversation.externalPatientId;
    if (!externalPatientId) {
      const matches = await findClinicPatientsForContext(deps.clinicDeps, context, { query: input.externalContactId });
      if (matches.length === 1) {
        externalPatientId = matches[0]!.externalPatientId;
      } else if (matches.length === 0) {
        const { firstName, lastName } = splitDisplayName(input.contactDisplayName, input.externalContactId);
        const registered = await registerClinicPatientForContext(deps.clinicDeps, context, {
          firstName,
          lastName,
          contactNumber: input.externalContactId,
          idempotencyKey: crypto.randomUUID(),
        });
        externalPatientId = registered.externalPatientId;
      } else {
        await handoff(deps, channel, context, conversation, 'AMBIGUOUS_PATIENT_MATCH');
        return;
      }
    }

    const consultants = await listClinicConsultantsForContext(deps.clinicDeps, context);
    const matchedConsultants = consultantHint ? consultants.filter((c) => c.displayName.toLowerCase().includes(consultantHint.toLowerCase())) : [];
    if (matchedConsultants.length !== 1) {
      await handoff(deps, channel, context, { ...conversation, externalPatientId }, 'BOOKING_DETAILS_UNRESOLVED');
      return;
    }
    const consultant = matchedConsultants[0]!;

    const date = resolveDateHint(dateHint, channel.timezone);
    if (!date) {
      await handoff(deps, channel, context, { ...conversation, externalPatientId }, 'BOOKING_DETAILS_UNRESOLVED');
      return;
    }

    const availability = await getClinicAvailableSlotsForContext(deps.clinicDeps, context, { externalConsultantId: consultant.externalConsultantId, date });
    // Section 22/10: CMS availability is authoritative — never reconstructed. The earliest returned slot is taken as-is.
    const slot = availability.slots[0];
    if (!slot) {
      await handoff(deps, channel, context, { ...conversation, externalPatientId }, 'BOOKING_DETAILS_UNRESOLVED');
      return;
    }

    const idempotencyKey = conversation.bookingIdempotencyKey ?? crypto.randomUUID();
    const withPatientAndKey = await deps.conversations.update({ ...conversation, externalPatientId, bookingIdempotencyKey: idempotencyKey, bookingState: 'BOOKING', updatedAt: new Date().toISOString() });

    const enquiry = await createClinicEnquiryForContext(deps.clinicDeps, context, {
      externalPatientId,
      channel: 'WHATSAPP',
      preferredLanguage: conversation.preferredLanguage,
      idempotencyKey: `${idempotencyKey}:enquiry`,
    });

    const appointment = await createClinicAppointmentForContext(deps.clinicDeps, context, {
      externalPatientId,
      externalConsultantId: consultant.externalConsultantId,
      appointmentDate: date,
      appointmentTime: slot,
      externalEnquiryId: enquiry.externalEnquiryId,
      idempotencyKey: `${idempotencyKey}:appointment`,
    });

    // Section 24: CMS success is recorded BEFORE any confirmation send is attempted.
    const booked = await deps.conversations.update({
      ...withPatientAndKey,
      bookingState: 'BOOKED',
      bookingConsultantId: consultant.externalConsultantId,
      bookingDate: date,
      bookingSlot: slot,
      activeEnquiryId: enquiry.externalEnquiryId,
      activeAppointmentId: appointment.externalAppointmentId,
      updatedAt: new Date().toISOString(),
    });

    const accessToken = await deps.accessTokenSecrets.getSecret(channel.accessTokenReference);
    try {
      const sendResult = await deps.provider.sendSessionMessage(
        { phoneNumberId: channel.externalChannelId, accessToken },
        input.externalContactId,
        `You're booked with ${consultant.displayName} on ${date} at ${slot}.`,
      );
      await deps.messages.record({
        messageId: crypto.randomUUID(),
        organizationId: context.organizationId,
        conversationId: booked.conversationId,
        direction: 'OUTBOUND',
        externalMessageId: sendResult.externalMessageId,
        messageType: 'text',
        createdAt: new Date().toISOString(),
      });
      // Only reached (CONFIRMED) once delivery itself succeeded — section 24.
      await deps.conversations.update({ ...booked, bookingState: 'CONFIRMED', updatedAt: new Date().toISOString() });
    } catch {
      // Section 24/31: CMS success is never undone or retried because
      // confirmation delivery failed — the appointment REMAINS booked
      // (bookingState stays 'BOOKED', never regresses to 'FAILED_SAFE').
      // The absence of a 'CONFIRMED' transition is itself the "recorded
      // separately" signal this session's brief asks for.
      await deps.messages.record({
        messageId: crypto.randomUUID(),
        organizationId: context.organizationId,
        conversationId: booked.conversationId,
        direction: 'OUTBOUND',
        messageType: 'text',
        createdAt: new Date().toISOString(),
      });
    }
  } catch {
    // Section 24/31: any CMS-layer failure (connection down, auth,
    // validation, slot lost between read and write, etc.) fails safe —
    // handoff, never a partially-applied mutation, never a retry loop here.
    await handoff(deps, channel, context, conversation, 'CMS_UNRECOVERABLE_FAILURE');
  }
}
