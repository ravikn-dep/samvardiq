import type { Conversation, CommunicationMessage } from './types.js';

/** Organization-scoped by signature — every method takes `organizationId` explicitly. */
export interface ConversationRepository {
  getByExternalContact(organizationId: string, channelId: string, externalContactId: string): Promise<Conversation | null>;
  create(conversation: Conversation): Promise<Conversation>;
  update(conversation: Conversation): Promise<Conversation>;
  getById(organizationId: string, conversationId: string): Promise<Conversation | null>;
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
