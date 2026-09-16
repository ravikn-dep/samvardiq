import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, primaryKey, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Physical PostgreSQL schema (CLINIC-W2B). `conversations`,
 * `communication_messages`, and `communication_message_content` are
 * organization-scoped, using the same `(organization_id, entity_id)`
 * composite-PK discipline every other package already established — they
 * are always looked up AFTER `context.organizationId` is already known
 * (post-`resolveTrustedContext`).
 *
 * `communication_channels` and `webhook_event_dedup` are deliberately
 * PLATFORM-GLOBAL (no RLS) — same precedent identity-access's own
 * `identities`/`identity_provider_links` already set. This is not a
 * relaxation for convenience: a channel lookup by `external_channel_id`
 * (the incoming webhook's own Meta phone_number_id) is *how* the
 * organization gets determined in the first place — RLS gated on
 * `app.current_org_id` would make that lookup structurally impossible
 * (with no context set, RLS would hide every row, including the very row
 * needed to establish one). `external_channel_id` carries a database
 * UNIQUE constraint, so this lookup can only ever return the one true
 * owning row regardless of org scoping — uniqueness, not RLS, is what
 * keeps it safe, exactly the same reasoning that already justifies
 * `identity_provider_links` having no RLS (a `(provider, providerSubject)`
 * lookup has the identical "must resolve before any org is known"
 * shape). Real authority is still established afterward, unconditionally,
 * by the unmodified `AuthorizationService.resolveTrustedContext()`.
 *
 * `communication_message_content` is a SEPARATE table from
 * `communication_messages` by deliberate design (section 14/26 of the W2
 * architecture doc) — it is the ONE place raw patient/clinic message text
 * is ever stored, always with a `purge_after` value, never indefinitely.
 *
 * RLS, the runtime role, and grants are NOT expressible in Drizzle's schema
 * DSL and are not generated from this file — see drizzle/0001_rls_and_roles.sql.
 */

export const communicationChannels = pgTable(
  'communication_channels',
  {
    organizationId: text('organization_id').notNull(),
    channelId: text('channel_id').notNull(),
    provider: text('provider').notNull(),
    externalChannelId: text('external_channel_id').notNull(),
    serviceIdentityId: text('service_identity_id').notNull(),
    serviceProviderSubject: text('service_provider_subject').notNull(),
    accessTokenReference: text('access_token_reference').notNull(),
    displayPhoneNumber: text('display_phone_number').notNull(),
    timezone: text('timezone').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.channelId] }), unique('communication_channels_external_channel_id_unique').on(table.externalChannelId)],
);

export const conversations = pgTable(
  'conversations',
  {
    organizationId: text('organization_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    channelId: text('channel_id').notNull(),
    externalContactId: text('external_contact_id').notNull(),
    state: text('state').notNull(),
    preferredLanguage: text('preferred_language').notNull(),
    externalPatientId: text('external_patient_id'),
    bookingState: text('booking_state').notNull(),
    bookingConsultantId: text('booking_consultant_id'),
    bookingDate: text('booking_date'),
    bookingSlot: text('booking_slot'),
    bookingIdempotencyKey: text('booking_idempotency_key'),
    activeEnquiryId: text('active_enquiry_id'),
    activeAppointmentId: text('active_appointment_id'),
    handoffTrigger: text('handoff_trigger'),
    handoffAt: timestamp('handoff_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.conversationId] }),
    unique('conversations_channel_contact_unique').on(table.organizationId, table.channelId, table.externalContactId),
    check('conversations_state_check', sql`${table.state} IN ('AI_ACTIVE','HUMAN_HANDOFF_REQUESTED','HUMAN_ACTIVE','WAITING_FOR_PATIENT','RESOLVED','CLOSED')`),
  ],
);

export const communicationMessages = pgTable(
  'communication_messages',
  {
    organizationId: text('organization_id').notNull(),
    messageId: text('message_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    direction: text('direction').notNull(),
    externalMessageId: text('external_message_id'),
    messageType: text('message_type').notNull(),
    structuredIntent: jsonb('structured_intent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.messageId] }),
    check('communication_messages_direction_check', sql`${table.direction} IN ('INBOUND','OUTBOUND')`),
  ],
);

export const communicationMessageContent = pgTable(
  'communication_message_content',
  {
    organizationId: text('organization_id').notNull(),
    messageId: text('message_id').notNull(),
    rawText: text('raw_text').notNull(),
    purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.messageId] })],
);

/** Platform-global — see file-level doc comment. */
export const webhookEventDedup = pgTable(
  'webhook_event_dedup',
  {
    provider: text('provider').notNull(),
    externalEventId: text('external_event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.externalEventId] })],
);
