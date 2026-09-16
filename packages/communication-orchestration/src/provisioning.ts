import type { IdentityRepository, IdentityProviderLinkRepository, MembershipRepository } from '@samvardiq/identity-access';

import type { CommunicationChannelRepository } from './channelRepository.js';
import type { CommunicationChannel } from './types.js';

export interface ProvisionChannelInput {
  channelId: string;
  organizationId: string;
  externalChannelId: string;
  displayPhoneNumber: string;
  timezone: string;
  accessTokenReference: string;
}

/**
 * The ONLY code path allowed to create a channel's service identity
 * (section 10/32.BS). Never called by webhook-triggered code — this
 * function takes no request/webhook input at all, only operator-supplied
 * configuration. Idempotent by construction: re-running with the same
 * `channelId`/`organizationId` fails on the repositories' own
 * duplicate-rejection (never silently overwrites), matching the
 * "collision-safe" requirement.
 *
 * Provisions, in order: a `principalType: 'service'` identity, its
 * `identity_provider_links` row (provider `'whatsapp-channel'`,
 * providerSubject = `channelId` — see channelEventVerifier.ts), an
 * `organization_memberships` row (`role: 'MEMBER'`, `approverRole`
 * omitted/null — ADR-IDENTITY-002), and the `CommunicationChannel` row
 * itself. All four are created together; if any step fails, whatever was
 * already created is NOT automatically rolled back here (this is a
 * one-time, human-operated, low-frequency action reviewed by whoever runs
 * it — not a hot path needing transactional wrapping at this layer; a
 * Postgres-transaction-wrapped version can be added if operational
 * experience shows partial-provisioning is a real problem).
 */
export async function provisionCommunicationChannel(
  deps: {
    identities: IdentityRepository;
    providerLinks: IdentityProviderLinkRepository;
    memberships: MembershipRepository;
    channels: CommunicationChannelRepository;
  },
  input: ProvisionChannelInput,
): Promise<CommunicationChannel> {
  const serviceIdentityId = `svc-whatsapp-${input.channelId}`;
  const serviceProviderSubject = input.channelId;

  await deps.identities.create({ identityId: serviceIdentityId, principalType: 'service', displayName: `WhatsApp channel ${input.displayPhoneNumber}`, status: 'active' });
  await deps.providerLinks.create({ identityId: serviceIdentityId, provider: 'whatsapp-channel', providerSubject: serviceProviderSubject });
  await deps.memberships.create({ organizationId: input.organizationId, identityId: serviceIdentityId, role: 'MEMBER', status: 'ACTIVE' });

  const now = new Date().toISOString();
  return deps.channels.create({
    channelId: input.channelId,
    organizationId: input.organizationId,
    provider: 'meta_whatsapp_cloud_api',
    externalChannelId: input.externalChannelId,
    serviceIdentityId,
    serviceProviderSubject,
    accessTokenReference: input.accessTokenReference,
    displayPhoneNumber: input.displayPhoneNumber,
    timezone: input.timezone,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}
