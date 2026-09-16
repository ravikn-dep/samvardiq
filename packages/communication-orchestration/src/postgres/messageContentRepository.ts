import { and, eq, lte } from 'drizzle-orm';

import type { MessageContentRepository } from '../messageContentRepository.js';
import type { MessageContent } from '../types.js';
import { withOrganizationContext, type Database } from './client.js';
import { communicationMessageContent } from './schema.js';

export class PostgresMessageContentRepository implements MessageContentRepository {
  constructor(private readonly db: Database) {}

  async record(content: MessageContent): Promise<void> {
    await withOrganizationContext(this.db, content.organizationId, async (tx) => {
      await tx.insert(communicationMessageContent).values({
        organizationId: content.organizationId,
        messageId: content.messageId,
        rawText: content.rawText,
        purgeAfter: new Date(content.purgeAfter),
      });
    });
  }

  async get(organizationId: string, messageId: string): Promise<MessageContent | null> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx.select().from(communicationMessageContent).where(and(eq(communicationMessageContent.organizationId, organizationId), eq(communicationMessageContent.messageId, messageId)));
      const row = rows[0];
      return row ? { organizationId: row.organizationId, messageId: row.messageId, rawText: row.rawText, purgeAfter: row.purgeAfter.toISOString() } : null;
    });
  }

  /**
   * Section 15: the deterministic purge mechanism itself — scoped to one
   * organization per call, matching RLS rather than fighting it (see the
   * interface's own doc comment). Runs under the same `samvardiq_app`
   * runtime role and `withOrganizationContext` as every other write in
   * this codebase; a production scheduler is what would loop over
   * organizations and invoke this once per org (not built here — see
   * "Known Limitations" in the W2 architecture doc; this method is the
   * proven mechanism, not the scheduler itself).
   */
  async purgeExpired(organizationId: string, now: Date = new Date()): Promise<number> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const deleted = await tx
        .delete(communicationMessageContent)
        .where(and(eq(communicationMessageContent.organizationId, organizationId), lte(communicationMessageContent.purgeAfter, now)))
        .returning();
      return deleted.length;
    });
  }
}
