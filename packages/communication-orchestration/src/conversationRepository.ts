import crypto from 'node:crypto';

import { InvalidHandoffCursorError } from './errors.js';
import type { Conversation, CommunicationMessage, HandoffEvent, HandoffResolutionOutcome } from './types.js';

export interface ListHumanHandoffsOptions {
  /** Bounded by the caller (the Fastify route schema clamps this — section 20); this repository trusts the value it is given. */
  limit: number;
  cursor?: string;
}

export interface HandoffPage {
  items: Conversation[];
  /** Present only if more results exist beyond this page. */
  nextCursor?: string;
}

interface HandoffCursor {
  updatedAt: string;
  conversationId: string;
}

/**
 * CLINIC-W2C, section 20: keyset (not offset) pagination on
 * `(updatedAt DESC, conversationId DESC)` — chosen over offset/skip
 * specifically because offset pagination duplicates/skips rows under
 * concurrent writes (a real risk here: a handed-off conversation's
 * `updatedAt` can change while staff are paging), which would fail the
 * "no duplicate rows across pagination" requirement outright. The cursor
 * is opaque to callers (base64url-encoded JSON) — never a raw sortable
 * value a client could tamper with to skip/replay pages meaningfully,
 * and always rejected outright (never guessed at) if it fails to decode.
 */
export function encodeHandoffCursor(cursor: HandoffCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeHandoffCursor(raw: string): HandoffCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidHandoffCursorError();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).updatedAt !== 'string' ||
    typeof (parsed as Record<string, unknown>).conversationId !== 'string'
  ) {
    throw new InvalidHandoffCursorError();
  }
  return parsed as HandoffCursor;
}

/** Tuple less-than for the (updatedAt DESC, conversationId DESC) ordering — ISO-8601 `toISOString()` strings compare lexicographically the same as chronologically, so plain string comparison is exact, not an approximation. */
function isBeforeCursor(candidate: HandoffCursor, cursor: HandoffCursor): boolean {
  if (candidate.updatedAt !== cursor.updatedAt) return candidate.updatedAt < cursor.updatedAt;
  return candidate.conversationId < cursor.conversationId;
}

/** CLINIC-W2D: the states the governed staff inbox shows — unclaimed and claimed handoffs. */
export const HANDOFF_INBOX_STATES = ['HUMAN_HANDOFF_REQUESTED', 'HUMAN_ACTIVE'] as const;

/**
 * CLINIC-W2D (Founder decisions W2D-01/02): the field values that start a fresh
 * AI booking journey, applied on RETURN_TO_AI and when a CLOSED conversation
 * reopens. RESET = transient state of the interrupted journey, including the
 * booking idempotency key, so a later booking can never replay the previous
 * CMS operation. PRESERVED by omission = preferredLanguage, externalPatientId,
 * activeEnquiryId, activeAppointmentId (completed business records/provenance).
 * Explicit nulls, never `undefined`: Drizzle's `.set()` skips undefined values.
 */
export const FRESH_JOURNEY = {
  state: 'AI_ACTIVE',
  bookingState: 'NEW',
  bookingConsultantId: null,
  bookingDate: null,
  bookingSlot: null,
  bookingIdempotencyKey: null,
  handoffTrigger: null,
  handoffAt: null,
  handoffOwnerIdentityId: null,
  handoffClaimedAt: null,
} as const;

/** CLOSE ends the active handoff (owner and current trigger cleared); the booking journey is reset only if the contact writes again. */
export const CLOSED_HANDOFF = { state: 'CLOSED', handoffTrigger: null, handoffAt: null, handoffOwnerIdentityId: null, handoffClaimedAt: null } as const;

export type ClaimHandoffResult = { kind: 'CLAIMED' | 'ALREADY_OWNER'; conversation: Conversation } | { kind: 'NOT_FOUND' | 'CONFLICT' };
export type ResolveHandoffResult = { kind: 'RESOLVED'; conversation: Conversation } | { kind: 'NOT_FOUND' | 'CONFLICT' };

/** Applies a reset to a domain object: null means the optional field is absent. */
function applyReset(conversation: Conversation, reset: Record<string, unknown>, now: string): Conversation {
  const next: Record<string, unknown> = { ...conversation, updatedAt: now };
  for (const [key, value] of Object.entries(reset)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as unknown as Conversation;
}

/** Organization-scoped by signature — every method takes `organizationId` explicitly. */
export interface ConversationRepository {
  getByExternalContact(organizationId: string, channelId: string, externalContactId: string): Promise<Conversation | null>;
  create(conversation: Conversation): Promise<Conversation>;
  update(conversation: Conversation): Promise<Conversation>;
  getById(organizationId: string, conversationId: string): Promise<Conversation | null>;
  /** CLINIC-W2C/W2D: this organization's conversations in HANDOFF_INBOX_STATES only — never another state, never another organization's rows. */
  listHumanHandoffs(organizationId: string, options: ListHumanHandoffsOptions): Promise<HandoffPage>;
  /**
   * CLINIC-W2D: atomically HUMAN_HANDOFF_REQUESTED -> HUMAN_ACTIVE owned by `ownerIdentityId`, plus a CLAIMED event,
   * in one transaction. Exactly one concurrent claimer wins; a retry by the current owner is ALREADY_OWNER (no new
   * event); anything else is CONFLICT.
   */
  claimHumanHandoff(organizationId: string, conversationId: string, ownerIdentityId: string): Promise<ClaimHandoffResult>;
  /** CLINIC-W2D: only the current owner of a HUMAN_ACTIVE handoff; state change and RESOLVED event in one transaction. */
  resolveHumanHandoff(organizationId: string, conversationId: string, ownerIdentityId: string, outcome: HandoffResolutionOutcome): Promise<ResolveHandoffResult>;
  /**
   * CLINIC-W2D: CLOSED -> fresh AI journey plus a REOPENED event (service actor), in one transaction. Called only by
   * inbound-event ingress, never by a read. Returns null when the conversation was not CLOSED.
   */
  reopenClosedConversation(organizationId: string, conversationId: string, serviceIdentityId: string): Promise<Conversation | null>;
  listHandoffEvents(organizationId: string, conversationId: string): Promise<HandoffEvent[]>;
}

export interface MessageRepository {
  record(message: CommunicationMessage): Promise<CommunicationMessage>;
  listByConversation(organizationId: string, conversationId: string): Promise<CommunicationMessage[]>;
}

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  private readonly events: HandoffEvent[] = [];

  private recordEvent(event: Omit<HandoffEvent, 'handoffId'>): void {
    this.events.push({ ...event, handoffId: crypto.randomUUID() });
  }

  // Each W2D method checks and writes with no `await` in between, so it is atomic on the single JS thread.
  async claimHumanHandoff(organizationId: string, conversationId: string, ownerIdentityId: string): Promise<ClaimHandoffResult> {
    const key = `${organizationId}::${conversationId}`;
    const current = this.conversations.get(key);
    if (!current) return { kind: 'NOT_FOUND' };
    if (current.state === 'HUMAN_ACTIVE' && current.handoffOwnerIdentityId === ownerIdentityId) return { kind: 'ALREADY_OWNER', conversation: { ...current } };
    if (current.state !== 'HUMAN_HANDOFF_REQUESTED') return { kind: 'CONFLICT' };
    const now = new Date().toISOString();
    const claimed: Conversation = { ...current, state: 'HUMAN_ACTIVE', handoffOwnerIdentityId: ownerIdentityId, handoffClaimedAt: now, updatedAt: now };
    this.conversations.set(key, claimed);
    this.recordEvent({ organizationId, conversationId, eventType: 'CLAIMED', actorIdentityId: ownerIdentityId, actorPrincipalType: 'human', handoffTrigger: current.handoffTrigger, occurredAt: now });
    return { kind: 'CLAIMED', conversation: { ...claimed } };
  }

  async resolveHumanHandoff(organizationId: string, conversationId: string, ownerIdentityId: string, outcome: HandoffResolutionOutcome): Promise<ResolveHandoffResult> {
    const key = `${organizationId}::${conversationId}`;
    const current = this.conversations.get(key);
    if (!current) return { kind: 'NOT_FOUND' };
    if (current.state !== 'HUMAN_ACTIVE' || current.handoffOwnerIdentityId !== ownerIdentityId) return { kind: 'CONFLICT' };
    const now = new Date().toISOString();
    const resolved = applyReset(current, outcome === 'RETURN_TO_AI' ? FRESH_JOURNEY : CLOSED_HANDOFF, now);
    this.conversations.set(key, resolved);
    this.recordEvent({ organizationId, conversationId, eventType: 'RESOLVED', actorIdentityId: ownerIdentityId, actorPrincipalType: 'human', outcome, handoffTrigger: current.handoffTrigger, occurredAt: now });
    return { kind: 'RESOLVED', conversation: { ...resolved } };
  }

  async reopenClosedConversation(organizationId: string, conversationId: string, serviceIdentityId: string): Promise<Conversation | null> {
    const key = `${organizationId}::${conversationId}`;
    const current = this.conversations.get(key);
    if (!current || current.state !== 'CLOSED') return null;
    const now = new Date().toISOString();
    const reopened = applyReset(current, FRESH_JOURNEY, now);
    this.conversations.set(key, reopened);
    this.recordEvent({ organizationId, conversationId, eventType: 'REOPENED', actorIdentityId: serviceIdentityId, actorPrincipalType: 'service', occurredAt: now });
    return { ...reopened };
  }

  async listHandoffEvents(organizationId: string, conversationId: string): Promise<HandoffEvent[]> {
    return this.events.filter((e) => e.organizationId === organizationId && e.conversationId === conversationId).map((e) => ({ ...e }));
  }

  async getByExternalContact(organizationId: string, channelId: string, externalContactId: string): Promise<Conversation | null> {
    for (const conversation of this.conversations.values()) {
      if (conversation.organizationId === organizationId && conversation.channelId === channelId && conversation.externalContactId === externalContactId) {
        return { ...conversation };
      }
    }
    return null;
  }

  async getById(organizationId: string, conversationId: string): Promise<Conversation | null> {
    const found = this.conversations.get(`${organizationId}::${conversationId}`);
    return found ? { ...found } : null;
  }

  async create(conversation: Conversation): Promise<Conversation> {
    const key = `${conversation.organizationId}::${conversation.conversationId}`;
    if (this.conversations.has(key)) throw new Error(`Duplicate conversation: ${key}`);
    this.conversations.set(key, { ...conversation });
    return { ...conversation };
  }

  async update(conversation: Conversation): Promise<Conversation> {
    const key = `${conversation.organizationId}::${conversation.conversationId}`;
    if (!this.conversations.has(key)) throw new Error(`Unknown conversation: ${key}`);
    this.conversations.set(key, { ...conversation });
    return { ...conversation };
  }

  async listHumanHandoffs(organizationId: string, options: ListHumanHandoffsOptions): Promise<HandoffPage> {
    const cursor = options.cursor ? decodeHandoffCursor(options.cursor) : undefined;
    const matches = [...this.conversations.values()]
      .filter((c) => c.organizationId === organizationId && (HANDOFF_INBOX_STATES as readonly string[]).includes(c.state))
      .filter((c) => !cursor || isBeforeCursor({ updatedAt: c.updatedAt, conversationId: c.conversationId }, cursor))
      .sort((a, b) => (a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.conversationId < b.conversationId ? 1 : -1));

    const items = matches.slice(0, options.limit).map((c) => ({ ...c }));
    const hasMore = matches.length > options.limit;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? encodeHandoffCursor({ updatedAt: last.updatedAt, conversationId: last.conversationId }) : undefined };
  }
}

export class InMemoryMessageRepository implements MessageRepository {
  private readonly messages: CommunicationMessage[] = [];

  async record(message: CommunicationMessage): Promise<CommunicationMessage> {
    const copy = { ...message };
    this.messages.push(copy);
    return copy;
  }

  async listByConversation(organizationId: string, conversationId: string): Promise<CommunicationMessage[]> {
    return this.messages.filter((m) => m.organizationId === organizationId && m.conversationId === conversationId).map((m) => ({ ...m }));
  }
}
