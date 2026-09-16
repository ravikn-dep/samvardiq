import type { AuthorizationService, TrustedOrganizationContext, VerifiedPrincipal } from '@samvardiq/identity-access';
import type { ConnectorSecretProvider } from '@samvardiq/clinic-cms-connector';

import type { CommunicationChannelRepository } from './channelRepository.js';
import { InvalidWebhookSignatureError, UnknownChannelError } from './errors.js';
import { parseMetaWebhookEvents, type InboundEvent } from './metaEvents.js';
import { verifyMetaWebhookSignature } from './metaSignature.js';
import type { CommunicationChannel } from './types.js';

/**
 * ADR-IDENTITY-002 (`ARCH-019`), implemented. Plays the exact role
 * `SupabaseIdentityProviderAdapter` plays for human sessions — "accept
 * untrusted credential material, perform real cryptographic/authoritative
 * verification, and either produce a VerifiedPrincipal or fail closed" —
 * for a webhook delivery instead of a JWT. Deliberately NOT shaped as
 * `IdentityProviderAdapter` (that interface is JWT-shaped by design; see
 * the ADR's own "The One Genuinely New Piece" section for why forcing this
 * into that interface would distort it rather than reuse it).
 *
 * Order matters and is exactly the ADR's own numbered list:
 * 1. verify Meta authenticity (HMAC over the RAW body, using a single
 *    platform-level App Secret — never per-channel; see types.ts's own
 *    note on why) — before touching the payload's content in any way;
 * 2. only once verified, parse the payload to obtain phone_number_id;
 * 3. resolve the enabled, server-side `CommunicationChannel`;
 * 4. resolve THAT channel's fixed, pre-provisioned service identity;
 * 5. produce the minimum `VerifiedPrincipal` the existing authorization
 *    system needs;
 * 6. call the existing, completely unmodified
 *    `AuthorizationService.resolveTrustedContext()`.
 *
 * Never creates an identity, never creates a membership, never assigns a
 * role or approverRole, never accepts a Samvardiq identity/organization id
 * from the payload, never interprets patient content, never chooses a CMS
 * connection, never executes an appointment operation.
 *
 * One Meta HTTP delivery is signed as a single unit, but its JSON body can
 * legitimately batch `entry`/`changes` objects for DIFFERENT
 * `phone_number_id`s (a business with multiple registered numbers, or
 * multiple WABAs behind one endpoint). Resolving only the FIRST event's
 * channel and applying it to the whole batch would let a second channel's
 * events be silently processed under the first channel's — and therefore
 * possibly a different organization's — TrustedOrganizationContext: a real
 * tenant-isolation gap, not a hypothetical one. So steps 3-6 run once PER
 * DISTINCT `externalChannelId` present in the verified payload, and each
 * group's events travel only with their own channel's resolved context.
 */
export interface ChannelEventVerifierDependencies {
  authz: AuthorizationService;
  channels: CommunicationChannelRepository;
  appSecrets: ConnectorSecretProvider;
  /** A single, platform-level reference (e.g. `env:META_WHATSAPP_APP_SECRET`) — resolved once, shared across every channel under this Meta App. */
  platformAppSecretReference: string;
}

export interface VerifiedChannelEvent {
  channel: CommunicationChannel;
  context: TrustedOrganizationContext;
  events: InboundEvent[];
}

const CHANNEL_PROVIDER = 'whatsapp-channel';

export async function verifyAndResolveChannelEvent(deps: ChannelEventVerifierDependencies, rawBody: string, signatureHeader: string | undefined): Promise<VerifiedChannelEvent[]> {
  const appSecret = await deps.appSecrets.getSecret(deps.platformAppSecretReference);
  if (!verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret)) {
    throw new InvalidWebhookSignatureError();
  }

  // Only now — after cryptographic verification — is anything in this
  // payload treated as authentic enough to read.
  const events = parseMetaWebhookEvents(rawBody);
  if (events.length === 0) throw new UnknownChannelError();

  const byExternalChannelId = new Map<string, InboundEvent[]>();
  for (const event of events) {
    const group = byExternalChannelId.get(event.externalChannelId);
    if (group) group.push(event);
    else byExternalChannelId.set(event.externalChannelId, [event]);
  }

  const resolved: VerifiedChannelEvent[] = [];
  for (const [externalChannelId, groupEvents] of byExternalChannelId) {
    const channel = await deps.channels.getEnabledByExternalChannelId(externalChannelId);
    // A channel this batch mentions but that isn't configured/enabled is
    // simply not processed — the SAME outcome as today's single-channel
    // "unknown channel" case, just scoped to this one group rather than
    // failing groups that DID resolve correctly.
    if (!channel || !channel.enabled) continue;

    const principal: VerifiedPrincipal = {
      provider: CHANNEL_PROVIDER,
      providerSubject: channel.serviceProviderSubject,
      verifiedAt: new Date().toISOString(),
    };

    // Existing, unmodified function. Independently re-derives membership —
    // the channel lookup above only produced a CANDIDATE organizationId;
    // this call is the actual authorization decision (ADR-IDENTITY-002's
    // own "not a bypass" reasoning, identical to the human bootstrap path).
    const context = await deps.authz.resolveTrustedContext({ principal, requestedOrganizationId: channel.organizationId });
    resolved.push({ channel, context, events: groupEvents });
  }

  if (resolved.length === 0) throw new UnknownChannelError();
  return resolved;
}
