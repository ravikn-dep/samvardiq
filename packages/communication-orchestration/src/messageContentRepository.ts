import type { MessageContent } from './types.js';

/**
 * The ONE repository allowed to touch raw message text (section
 * 15/23/26 of the session brief). `record` always requires a `purgeAfter`
 * — there is no code path in this interface that writes an
 * indefinite-retention row. `purgeExpired` is the deterministic purge
 * capability section 15 requires in place of a real production scheduler
 * (not built here — see docs/integrations/CLINIC_W2_COMMUNICATION_ARCHITECTURE.md
 * for the deferred-scheduling note).
 */
export interface MessageContentRepository {
  record(content: MessageContent): Promise<void>;
  get(organizationId: string, messageId: string): Promise<MessageContent | null>;
  /**
   * Deletes this ONE organization's rows whose `purgeAfter` has passed.
   * Scoped per-organization deliberately, matching RLS rather than
   * fighting it (see the Postgres implementation's own doc comment) — a
   * production scheduler loops over organizations and calls this once
   * per org, rather than this method spanning every tenant in one call.
   */
  purgeExpired(organizationId: string, now?: Date): Promise<number>;
}

export class InMemoryMessageContentRepository implements MessageContentRepository {
  private readonly content = new Map<string, MessageContent>();

  async record(content: MessageContent): Promise<void> {
    this.content.set(`${content.organizationId}::${content.messageId}`, { ...content });
  }

  async get(organizationId: string, messageId: string): Promise<MessageContent | null> {
    const found = this.content.get(`${organizationId}::${messageId}`);
    return found ? { ...found } : null;
  }

  async purgeExpired(organizationId: string, now: Date = new Date()): Promise<number> {
    let purged = 0;
    for (const [key, row] of this.content.entries()) {
      if (row.organizationId === organizationId && new Date(row.purgeAfter).getTime() <= now.getTime()) {
        this.content.delete(key);
        purged += 1;
      }
    }
    return purged;
  }
}
