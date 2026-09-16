import type { CommunicationChannel } from './types.js';

/**
 * Organization-scoped by signature (mirrors `ClinicCmsConnectionRepository`
 * from W1B exactly). `getEnabledByExternalChannelId` is the ONLY lookup a
 * webhook may use — it takes the provider's own channel identifier
 * (untrusted input, but not patient-controlled — see `ChannelEventVerifier`)
 * and returns the channel only if it is enabled, never leaking a disabled
 * channel's existence via a different code path.
 */
export interface CommunicationChannelRepository {
  getEnabledByExternalChannelId(externalChannelId: string): Promise<CommunicationChannel | null>;
  create(channel: CommunicationChannel): Promise<CommunicationChannel>;
}

export class InMemoryCommunicationChannelRepository implements CommunicationChannelRepository {
  private readonly channels = new Map<string, CommunicationChannel>();

  async getEnabledByExternalChannelId(externalChannelId: string): Promise<CommunicationChannel | null> {
    for (const channel of this.channels.values()) {
      if (channel.externalChannelId === externalChannelId && channel.enabled) return { ...channel };
    }
    return null;
  }

  async create(channel: CommunicationChannel): Promise<CommunicationChannel> {
    const key = `${channel.organizationId}::${channel.channelId}`;
    if (this.channels.has(key)) throw new Error(`Duplicate channel: ${key}`);
    this.channels.set(key, { ...channel });
    return { ...channel };
  }
}
