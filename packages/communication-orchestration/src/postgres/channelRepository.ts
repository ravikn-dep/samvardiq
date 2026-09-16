import { and, eq } from 'drizzle-orm';

import type { CommunicationChannelRepository } from '../channelRepository.js';
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
export class PostgresCommunicationChannelRepository implements CommunicationChannelRepository {
  constructor(private readonly db: Database) {}

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
