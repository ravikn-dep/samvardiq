import type { FastifyInstance } from 'fastify';
import {
  InvalidWebhookSignatureError,
  UnknownChannelError,
  ChannelDisabledError,
  MalformedProviderPayloadError,
  processWhatsAppWebhook,
  verifyMetaWebhookHandshake,
  type WebhookIngressDependencies,
} from '@samvardiq/communication-orchestration';

export type WhatsAppWebhookRouteDependencies = WebhookIngressDependencies & { metaWebhookVerifyToken: string };

/**
 * CLINIC-W2B, section 12: the minimum Fastify ingress. This route does
 * NOT parse patient intent, does NOT choose an organization, does NOT
 * query the CMS, does NOT contain any appointment orchestration, and
 * never logs the raw body/signature/secret — every one of those already
 * lives in `processWhatsAppWebhook` (application-service layer) or the
 * connector/orchestrator it delegates to. Its only two jobs are: (1)
 * preserve the exact raw body Meta signed (ADR-HTTP-001's own documented
 * `addContentTypeParser`-scoped-to-a-route extension point, used here for
 * the first time), and (2) map the resulting outcome to an HTTP response
 * shape Meta's own retry semantics expect.
 */
export function whatsappWebhookRoute(app: FastifyInstance, deps: WhatsAppWebhookRouteDependencies): void {
  app.register(async (instance) => {
    // Scoped to THIS plugin instance only (Fastify's encapsulation model) —
    // every other route in the application keeps the default JSON parser
    // unchanged. Captures the exact bytes on the wire; nothing here parses
    // the body as JSON — signature verification requires the raw string,
    // and `processWhatsAppWebhook` parses it internally only after the
    // signature has already been verified.
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    instance.get<{ Querystring: Record<string, string> }>('/webhooks/meta/whatsapp', async (request, reply) => {
      const challenge = verifyMetaWebhookHandshake(
        { 'hub.mode': request.query['hub.mode'], 'hub.verify_token': request.query['hub.verify_token'], 'hub.challenge': request.query['hub.challenge'] },
        deps.metaWebhookVerifyToken,
      );
      if (challenge === null) {
        reply.code(403).send({ error: 'Forbidden' });
        return;
      }
      reply.code(200).send(challenge);
    });

    instance.post('/webhooks/meta/whatsapp', async (request, reply) => {
      const rawBody = typeof request.body === 'string' ? request.body : '';
      const signatureHeader = request.headers['x-hub-signature-256'];

      try {
        await processWhatsAppWebhook(deps, rawBody, Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader);
        reply.code(200).send({ status: 'ok' });
      } catch (error) {
        if (error instanceof InvalidWebhookSignatureError) {
          // Section 32.A/B: a security-relevant rejection, never a silent 200.
          reply.code(401).send({ error: 'Unauthorized' });
          return;
        }
        if (error instanceof UnknownChannelError || error instanceof ChannelDisabledError || error instanceof MalformedProviderPayloadError) {
          // Acknowledged (never retried by Meta) — retrying an event that
          // can never resolve to a valid channel/payload would only cause
          // a retry storm for no benefit (section 17/31).
          reply.code(200).send({ status: 'ignored' });
          return;
        }
        // Any other failure (e.g. a transient DB/CMS issue) is left to
        // Meta's own documented retry/backoff behavior — never logged with
        // request/response body content (section 29).
        request.log.error({ err: error }, 'unhandled webhook processing error');
        reply.code(500).send({ error: 'Internal Server Error' });
      }
    });
  });
}
