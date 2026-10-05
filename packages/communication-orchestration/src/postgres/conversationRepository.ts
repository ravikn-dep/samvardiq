import crypto from 'node:crypto';

import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm';

import {
  CLOSED_HANDOFF,
  FRESH_JOURNEY,
  HANDOFF_INBOX_STATES,
  decodeHandoffCursor,
  encodeHandoffCursor,
  type ClaimHandoffResult,
  type ConversationRepository,
  type HandoffPage,
  type ListHumanHandoffsOptions,
  type MessageRepository,
  type ResolveHandoffResult,
} from '../conversationRepository.js';
import type { CommunicationMessage, Conversation, ConversationState, HandoffEvent, HandoffResolutionOutcome, MessageDirection, MessageType } from '../types.js';
import { withOrganizationContext, type Database } from './client.js';
import { communicationMessages, conversationHandoffs, conversations } from './schema.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** CLINIC-W2D: every handoff state change writes its audit row through this, inside the caller's transaction. */
async function insertHandoffEvent(tx: Tx, event: Omit<HandoffEvent, 'handoffId' | 'occurredAt'>, occurredAt: Date): Promise<void> {
  await tx.insert(conversationHandoffs).values({ ...event, handoffId: crypto.randomUUID(), occurredAt });
}

function toHandoffEvent(row: typeof conversationHandoffs.$inferSelect): HandoffEvent {
  return {
    handoffId: row.handoffId,
    organizationId: row.organizationId,
    conversationId: row.conversationId,
    eventType: row.eventType as HandoffEvent['eventType'],
    actorIdentityId: row.actorIdentityId,
    actorPrincipalType: row.actorPrincipalType as HandoffEvent['actorPrincipalType'],
    outcome: (row.outcome as HandoffResolutionOutcome | null) ?? undefined,
    handoffTrigger: (row.handoffTrigger as HandoffEvent['handoffTrigger']) ?? undefined,
    occurredAt: row.occurredAt.toISOString(),
  };
}

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
    handoffOwnerIdentityId: row.handoffOwnerIdentityId ?? undefined,
    handoffClaimedAt: row.handoffClaimedAt?.toISOString(),
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

  async listHumanHandoffs(organizationId: string, options: ListHumanHandoffsOptions): Promise<HandoffPage> {
    const cursor = options.cursor ? decodeHandoffCursor(options.cursor) : undefined;
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const conditions = [eq(conversations.organizationId, organizationId), inArray(conversations.state, [...HANDOFF_INBOX_STATES])];
      if (cursor) {
        const cursorDate = new Date(cursor.updatedAt);
        conditions.push(or(lt(conversations.updatedAt, cursorDate), and(eq(conversations.updatedAt, cursorDate), lt(conversations.conversationId, cursor.conversationId)))!);
      }
      const rows = await tx
        .select()
        .from(conversations)
        .where(and(...conditions))
        .orderBy(desc(conversations.updatedAt), desc(conversations.conversationId))
        .limit(options.limit + 1);

      const hasMore = rows.length > options.limit;
      const page = rows.slice(0, options.limit).map(toConversation);
      const last = page[page.length - 1];
      return { items: page, nextCursor: hasMore && last ? encodeHandoffCursor({ updatedAt: last.updatedAt, conversationId: last.conversationId }) : undefined };
    });
  }

  /**
   * One state-guarded UPDATE: under concurrent claims PostgreSQL row-locks the conversation, and the loser re-checks
   * `state = 'HUMAN_HANDOFF_REQUESTED'` after the winner commits, matches nothing, and falls through to CONFLICT.
   */
  async claimHumanHandoff(organizationId: string, conversationId: string, ownerIdentityId: string): Promise<ClaimHandoffResult> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const now = new Date();
      const key = and(eq(conversations.organizationId, organizationId), eq(conversations.conversationId, conversationId));
      const [claimed] = await tx
        .update(conversations)
        .set({ state: 'HUMAN_ACTIVE', handoffOwnerIdentityId: ownerIdentityId, handoffClaimedAt: now, updatedAt: now })
        .where(and(key, eq(conversations.state, 'HUMAN_HANDOFF_REQUESTED')))
        .returning();
      if (claimed) {
        await insertHandoffEvent(tx, { organizationId, conversationId, eventType: 'CLAIMED', actorIdentityId: ownerIdentityId, actorPrincipalType: 'human', handoffTrigger: claimed.handoffTrigger as HandoffEvent['handoffTrigger'] }, now);
        return { kind: 'CLAIMED', conversation: toConversation(claimed) };
      }
      const [current] = await tx.select().from(conversations).where(key);
      if (!current) return { kind: 'NOT_FOUND' };
      if (current.state === 'HUMAN_ACTIVE' && current.handoffOwnerIdentityId === ownerIdentityId) return { kind: 'ALREADY_OWNER', conversation: toConversation(current) };
      return { kind: 'CONFLICT' };
    });
  }

  async resolveHumanHandoff(organizationId: string, conversationId: string, ownerIdentityId: string, outcome: HandoffResolutionOutcome): Promise<ResolveHandoffResult> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const now = new Date();
      const key = and(eq(conversations.organizationId, organizationId), eq(conversations.conversationId, conversationId));
      // Row lock first, so the trigger being resolved is read before the update clears it and no other writer interleaves.
      const [current] = await tx.select().from(conversations).where(key).for('update');
      if (!current) return { kind: 'NOT_FOUND' };
      if (current.state !== 'HUMAN_ACTIVE' || current.handoffOwnerIdentityId !== ownerIdentityId) return { kind: 'CONFLICT' };
      const [resolved] = await tx
        .update(conversations)
        .set({ ...(outcome === 'RETURN_TO_AI' ? FRESH_JOURNEY : CLOSED_HANDOFF), updatedAt: now })
        .where(key)
        .returning();
      await insertHandoffEvent(tx, { organizationId, conversationId, eventType: 'RESOLVED', actorIdentityId: ownerIdentityId, actorPrincipalType: 'human', outcome, handoffTrigger: current.handoffTrigger as HandoffEvent['handoffTrigger'] }, now);
      return { kind: 'RESOLVED', conversation: toConversation(resolved!) };
    });
  }

  async reopenClosedConversation(organizationId: string, conversationId: string, serviceIdentityId: string): Promise<Conversation | null> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const now = new Date();
      const [reopened] = await tx
        .update(conversations)
        .set({ ...FRESH_JOURNEY, updatedAt: now })
        .where(and(eq(conversations.organizationId, organizationId), eq(conversations.conversationId, conversationId), eq(conversations.state, 'CLOSED')))
        .returning();
      if (!reopened) return null;
      await insertHandoffEvent(tx, { organizationId, conversationId, eventType: 'REOPENED', actorIdentityId: serviceIdentityId, actorPrincipalType: 'service' }, now);
      return toConversation(reopened);
    });
  }

  async listHandoffEvents(organizationId: string, conversationId: string): Promise<HandoffEvent[]> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(conversationHandoffs)
        .where(and(eq(conversationHandoffs.organizationId, organizationId), eq(conversationHandoffs.conversationId, conversationId)))
        .orderBy(asc(conversationHandoffs.occurredAt), asc(conversationHandoffs.handoffId));
      return rows.map(toHandoffEvent);
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
