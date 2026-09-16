/**
 * CLINIC-W2B domain types. Intent vocabulary and states are deliberately
 * the narrow W2B slice only (section 17/20 of the session brief) — not the
 * full future catalogue described in `docs/integrations/CLINIC_W2_COMMUNICATION_ARCHITECTURE.md`.
 */

export type CommunicationProviderName = 'meta_whatsapp_cloud_api';

/**
 * Organization-scoped, server-side channel configuration (ADR-IDENTITY-002
 * §8/§12 of the W2 architecture doc). `serviceIdentityId` is the
 * pre-provisioned, operator-created `principalType: 'service'` identity
 * this channel's events execute as — never created or elevated by
 * webhook-triggered code (see provisioning.ts).
 *
 * Deliberately NO webhook-signature secret on this type: Meta's real
 * security model is one App Secret per Meta App/webhook subscription,
 * which can legitimately cover multiple phone numbers — not one secret
 * per channel. That secret is a single, platform-level
 * `ConnectorSecretProvider` reference the webhook composition root
 * supplies directly to `verifyAndResolveChannelEvent`, resolved and
 * verified BEFORE any channel lookup happens (see channelEventVerifier.ts).
 */
export interface CommunicationChannel {
  readonly channelId: string;
  readonly organizationId: string;
  readonly provider: CommunicationProviderName;
  readonly externalChannelId: string; // Meta phone_number_id
  readonly serviceIdentityId: string;
  readonly serviceProviderSubject: string; // the providerSubject registered in identity_provider_links for this channel's service identity
  readonly accessTokenReference: string; // outbound-send bearer token
  readonly displayPhoneNumber: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ConversationState = 'AI_ACTIVE' | 'HUMAN_HANDOFF_REQUESTED' | 'HUMAN_ACTIVE' | 'WAITING_FOR_PATIENT' | 'RESOLVED' | 'CLOSED';

export type BookingState =
  | 'NEW'
  | 'INTENT_CONFIRMED'
  | 'PATIENT_RESOLUTION'
  | 'CONSULTANT_SELECTION'
  | 'DATE_SELECTION'
  | 'SLOT_RETRIEVAL'
  | 'SLOT_OFFERED'
  | 'SLOT_SELECTED'
  | 'ENQUIRY_CREATION'
  | 'BOOKING'
  | 'BOOKED'
  | 'CONFIRMED'
  | 'HUMAN_HANDOFF_REQUESTED'
  | 'FAILED_SAFE';

export type PreferredLanguage = 'en-IN' | 'hi-IN' | 'te-IN' | 'mixed';

export type HandoffTrigger =
  | 'PATIENT_REQUEST'
  | 'UNKNOWN_AFTER_CLARIFICATION'
  | 'LOW_CONFIDENCE'
  | 'CMS_UNRECOVERABLE_FAILURE'
  | 'AMBIGUOUS_PATIENT_MATCH'
  | 'BOOKING_DETAILS_UNRESOLVED'
  | 'BOOKING_ALREADY_IN_PROGRESS'
  | 'POLICY_VIOLATION';

export interface Conversation {
  readonly conversationId: string;
  readonly organizationId: string;
  readonly channelId: string;
  readonly externalContactId: string; // WhatsApp wa_id — a contact hint, never an authority input (section 8 of the architecture doc)
  readonly state: ConversationState;
  readonly preferredLanguage: PreferredLanguage;
  readonly externalPatientId?: string;
  readonly bookingState: BookingState;
  readonly bookingConsultantId?: string;
  readonly bookingDate?: string;
  readonly bookingSlot?: string;
  readonly bookingIdempotencyKey?: string;
  readonly activeEnquiryId?: string;
  readonly activeAppointmentId?: string;
  readonly handoffTrigger?: HandoffTrigger;
  readonly handoffAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The only two intents this slice implements (section 17). */
export type Intent = 'APPOINTMENT_BOOK' | 'UNKNOWN';

/**
 * The interpreter's ENTIRE output surface (section 18). No field here can
 * be read as an operation name, a handler name, a tool name, or a route —
 * every consumer of this type (CommunicationPolicy, BookingOrchestrator)
 * only ever branches on the closed `intent` enum and treats every other
 * field as an untrusted hint requiring separate, deterministic validation
 * (e.g. `dateHint` is never parsed as a literal date without going through
 * real date-parsing/validation code first).
 */
export interface StructuredAdministrativeIntent {
  intent: Intent;
  languageDetected: PreferredLanguage;
  confidence: number; // 0..1
  consultantHint?: string;
  dateHint?: string;
}

export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type MessageType = 'text' | 'template' | 'unsupported';

/** Safe metadata only — never message text (see MessageContent). */
export interface CommunicationMessage {
  readonly messageId: string;
  readonly organizationId: string;
  readonly conversationId: string;
  readonly direction: MessageDirection;
  readonly externalMessageId?: string; // wamid — dedup key for inbound; provider message id for outbound
  readonly messageType: MessageType;
  readonly structuredIntent?: StructuredAdministrativeIntent;
  readonly createdAt: string;
}

/**
 * The ONE table allowed to hold raw patient/clinic message text (section
 * 15/26 of the session brief; §7 of the architecture doc). `purgeAfter` is
 * always set at write time — never an indefinite-retention row.
 */
export interface MessageContent {
  readonly organizationId: string;
  readonly messageId: string;
  readonly rawText: string;
  readonly purgeAfter: string;
}
