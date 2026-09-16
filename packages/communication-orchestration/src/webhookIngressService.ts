import { handleInboundTextEvent, type BookingOrchestratorDependencies } from './bookingOrchestrator.js';
import { verifyAndResolveChannelEvent, type ChannelEventVerifierDependencies } from './channelEventVerifier.js';
import type { WebhookEventDedupRepository } from './webhookDedupRepository.js';

export interface WebhookIngressDependencies extends ChannelEventVerifierDependencies, BookingOrchestratorDependencies {
  dedup: WebhookEventDedupRepository;
}

const DEDUP_PROVIDER = 'meta_whatsapp_cloud_api';

/**
 * The application-service entry point a thin Fastify route calls (section
 * 12: "route must not... contain appointment orchestration"). Order:
 * verify authenticity -> per-event dedup -> hand off to the booking
 * orchestrator. Status callbacks and unsupported message types are
 * acknowledged but do not currently drive any state change beyond
 * dedup (section 27 leaves status-callback handling minimal for this
 * slice — no regression risk since nothing currently reads message
 * delivery status).
 *
 * One delivery can resolve to MULTIPLE independently-verified
 * channel/context groups (see channelEventVerifier.ts) — each group's
 * events are only ever processed with THAT group's own channel/context,
 * never a different group's.
 */
export async function processWhatsAppWebhook(deps: WebhookIngressDependencies, rawBody: string, signatureHeader: string | undefined): Promise<void> {
  const groups = await verifyAndResolveChannelEvent(deps, rawBody, signatureHeader);

  for (const { channel, context, events } of groups) {
    for (const event of events) {
      if (event.externalMessageId) {
        const isNew = await deps.dedup.reserve(DEDUP_PROVIDER, event.externalMessageId);
        if (!isNew) continue; // section 13/32.U/V: duplicate delivery, business action already occurred at most once
      }

      if (event.type === 'text') {
        await handleInboundTextEvent(deps, channel, context, {
          externalChannelId: event.externalChannelId,
          externalContactId: event.externalContactId,
          externalMessageId: event.externalMessageId,
          text: event.text,
          contactDisplayName: event.contactDisplayName,
        });
      }
      // 'status' and 'unsupported' events are deduplicated and otherwise
      // deliberately not acted upon in this slice — see doc comment above.
    }
  }
}
