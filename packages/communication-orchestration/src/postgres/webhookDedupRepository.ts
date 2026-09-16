import type { WebhookEventDedupRepository } from '../webhookDedupRepository.js';
import type { Database } from './client.js';
import { webhookEventDedup } from './schema.js';

/**
 * Atomic "insert if absent" via the table's own primary-key uniqueness —
 * `onConflictDoNothing` plus checking whether a row actually came back is
 * what makes this collision-safe under concurrent delivery (section 13),
 * not a check-then-insert race. Platform-global — no organization context,
 * matching the schema's own design (see schema.ts's file-level comment).
 */
export class PostgresWebhookEventDedupRepository implements WebhookEventDedupRepository {
  constructor(private readonly db: Database) {}

  async reserve(provider: string, externalEventId: string): Promise<boolean> {
    const inserted = await this.db.insert(webhookEventDedup).values({ provider, externalEventId }).onConflictDoNothing().returning();
    return inserted.length > 0;
  }
}
