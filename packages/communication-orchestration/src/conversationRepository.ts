import { InvalidHandoffCursorError } from './errors.js';
import type { Conversation, CommunicationMessage } from './types.js';

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

/** Organization-scoped by signature — every method takes `organizationId` explicitly. */
export interface ConversationRepository {
  getByExternalContact(organizationId: string, channelId: string, externalContactId: string): Promise<Conversation | null>;
  create(conversation: Conversation): Promise<Conversation>;
  update(conversation: Conversation): Promise<Conversation>;
  getById(organizationId: string, conversationId: string): Promise<Conversation | null>;
  /** CLINIC-W2C: conversations currently in `HUMAN_HANDOFF_REQUESTED` for this organization only — never any other state, never another organization's rows. */
  listHumanHandoffs(organizationId: string, options: ListHumanHandoffsOptions): Promise<HandoffPage>;
}

export interface MessageRepository {
  record(message: CommunicationMessage): Promise<CommunicationMessage>;
  listByConversation(organizationId: string, conversationId: string): Promise<CommunicationMessage[]>;
}

export class InMemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();

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
      .filter((c) => c.organizationId === organizationId && c.state === 'HUMAN_HANDOFF_REQUESTED')
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
