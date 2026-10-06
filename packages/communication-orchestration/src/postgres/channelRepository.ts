import { and, eq } from 'drizzle-orm';

import type { CommunicationChannelRepository } from '../channelRepository.js';
import type { RetentionOrganizationSource } from '../retentionMaintenance.js';
import type { CommunicationChannel, CommunicationProviderName } from '../types.js';
import type { Database } from './client.js';
import { communicationChannels } from './schema.js';

function toChannel(row: typeof communicationChannels.$inferSelect): CommunicationChannel {
  return {
    channelId: row.channelId,
    organizationId: row.organizationId,
    provider: row.provider as CommunicationProviderName,
    externalChannelId: row.externalChannelId,
    serviceIdentityId: row.serviceIdentityId,
    serviceProviderSubject: row.serviceProviderSubject,
    accessTokenReference: row.accessTokenReference,
    displayPhoneNumber: row.displayPhoneNumber,
    timezone: row.timezone,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Platform-global table (schema.ts's own file-level comment explains why:
 * this lookup is HOW the organization gets determined, so it cannot itself
 * be gated on an org context that doesn't exist yet). Safety comes from
 * `external_channel_id`'s database UNIQUE constraint, not from RLS —
 * verified by a dedicated integration test proving a duplicate
 * `external_channel_id` is rejected at the database level.
 */
export class PostgresCommunicationChannelRepository implements CommunicationChannelRepository, RetentionOrganizationSource {
  constructor(private readonly db: Database) {}

  /**
   * Retention enumeration (PLATFORM-JOBS-W1): every organization that has
   * EVER had a channel — enabled or disabled. Raw content is only ever
   * written under a context resolved from a channel's organization
   * (channelEventVerifier.ts), and the runtime role cannot UPDATE or DELETE
   * channel rows, so this set always covers every organization that can hold
   * purgeable content. Identifiers only; no content is read.
   */
  async listOrganizationIdsWithChannels(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ organizationId: communicationChannels.organizationId }).from(communicationChannels).orderBy(communicationChannels.organizationId);
    return rows.map((r) => r.organizationId);
  }

  async getEnabledByExternalChannelId(externalChannelId: string): Promise<CommunicationChannel | null> {
    const rows = await this.db
      .select()
      .from(communicationChannels)
      .where(and(eq(communicationChannels.externalChannelId, externalChannelId), eq(communicationChannels.enabled, true)));
    return rows[0] ? toChannel(rows[0]) : null;
  }

  async create(channel: CommunicationChannel): Promise<CommunicationChannel> {
    const [row] = await this.db
      .insert(communicationChannels)
      .values({
        organizationId: channel.organizationId,
        channelId: channel.channelId,
        provider: channel.provider,
        externalChannelId: channel.externalChannelId,
        serviceIdentityId: channel.serviceIdentityId,
        serviceProviderSubject: channel.serviceProviderSubject,
        accessTokenReference: channel.accessTokenReference,
        displayPhoneNumber: channel.displayPhoneNumber,
        timezone: channel.timezone,
        enabled: channel.enabled,
      })
      .returning();
    return toChannel(row!);
  }
}
