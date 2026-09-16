import { and, eq } from 'drizzle-orm';

import type { ConversationRepository, MessageRepository } from '../conversationRepository.js';
import type { CommunicationMessage, Conversation, ConversationState, MessageDirection, MessageType } from '../types.js';
import { withOrganizationContext, type Database } from './client.js';
import { communicationMessages, conversations } from './schema.js';

function toConversation(row: typeof conversations.$inferSelect): Conversation {
  return {
    conversationId: row.conversationId,
    organizationId: row.organizationId,
    channelId: row.channelId,
    externalContactId: row.externalContactId,
    state: row.state as ConversationState,
    preferredLanguage: row.preferredLanguage as Conversation['preferredLanguage'],
    externalPatientId: row.externalPatientId ?? undefined,
    bookingState: row.bookingState as Conversation['bookingState'],
    bookingConsultantId: row.bookingConsultantId ?? undefined,
    bookingDate: row.bookingDate ?? undefined,
    bookingSlot: row.bookingSlot ?? undefined,
    bookingIdempotencyKey: row.bookingIdempotencyKey ?? undefined,
    activeEnquiryId: row.activeEnquiryId ?? undefined,
    activeAppointmentId: row.activeAppointmentId ?? undefined,
    handoffTrigger: (row.handoffTrigger as Conversation['handoffTrigger']) ?? undefined,
    handoffAt: row.handoffAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) {}

  async getByExternalContact(organizationId: string, channelId: string, externalContactId: string): Promise<Conversation | null> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.organizationId, organizationId), eq(conversations.channelId, channelId), eq(conversations.externalContactId, externalContactId)));
      return rows[0] ? toConversation(rows[0]) : null;
    });
  }

  async getById(organizationId: string, conversationId: string): Promise<Conversation | null> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx.select().from(conversations).where(and(eq(conversations.organizationId, organizationId), eq(conversations.conversationId, conversationId)));
      return rows[0] ? toConversation(rows[0]) : null;
    });
  }

  async create(conversation: Conversation): Promise<Conversation> {
    return withOrganizationContext(this.db, conversation.organizationId, async (tx) => {
      const [row] = await tx
        .insert(conversations)
        .values({
          organizationId: conversation.organizationId,
          conversationId: conversation.conversationId,
          channelId: conversation.channelId,
          externalContactId: conversation.externalContactId,
          state: conversation.state,
          preferredLanguage: conversation.preferredLanguage,
          externalPatientId: conversation.externalPatientId,
          bookingState: conversation.bookingState,
        })
        .returning();
      return toConversation(row!);
    });
  }

  async update(conversation: Conversation): Promise<Conversation> {
    return withOrganizationContext(this.db, conversation.organizationId, async (tx) => {
      const [row] = await tx
        .update(conversations)
        .set({
          state: conversation.state,
          preferredLanguage: conversation.preferredLanguage,
          externalPatientId: conversation.externalPatientId,
          bookingState: conversation.bookingState,
          bookingConsultantId: conversation.bookingConsultantId,
          bookingDate: conversation.bookingDate,
          bookingSlot: conversation.bookingSlot,
          bookingIdempotencyKey: conversation.bookingIdempotencyKey,
          activeEnquiryId: conversation.activeEnquiryId,
          activeAppointmentId: conversation.activeAppointmentId,
          handoffTrigger: conversation.handoffTrigger,
          handoffAt: conversation.handoffAt ? new Date(conversation.handoffAt) : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(conversations.organizationId, conversation.organizationId), eq(conversations.conversationId, conversation.conversationId)))
        .returning();
      return toConversation(row!);
    });
  }
}

function toMessage(row: typeof communicationMessages.$inferSelect): CommunicationMessage {
  return {
    messageId: row.messageId,
    organizationId: row.organizationId,
    conversationId: row.conversationId,
    direction: row.direction as MessageDirection,
    externalMessageId: row.externalMessageId ?? undefined,
    messageType: row.messageType as MessageType,
    structuredIntent: (row.structuredIntent as CommunicationMessage['structuredIntent']) ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly db: Database) {}

  async record(message: CommunicationMessage): Promise<CommunicationMessage> {
    return withOrganizationContext(this.db, message.organizationId, async (tx) => {
      const [row] = await tx
        .insert(communicationMessages)
        .values({
          organizationId: message.organizationId,
          messageId: message.messageId,
          conversationId: message.conversationId,
          direction: message.direction,
          externalMessageId: message.externalMessageId,
          messageType: message.messageType,
          structuredIntent: message.structuredIntent,
        })
        .returning();
      return toMessage(row!);
    });
  }

  async listByConversation(organizationId: string, conversationId: string): Promise<CommunicationMessage[]> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx.select().from(communicationMessages).where(and(eq(communicationMessages.organizationId, organizationId), eq(communicationMessages.conversationId, conversationId)));
      return rows.map(toMessage);
    });
  }
}
