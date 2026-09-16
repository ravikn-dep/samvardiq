import { OutboundSendFailedError } from './errors.js';

export interface SendResult {
  externalMessageId: string;
}

export interface TemplateRef {
  name: string;
  languageCode: string;
  bodyParameters: string[];
}

/**
 * Provider-neutral outbound boundary (section 23 of the architecture doc,
 * "no speculative full omnichannel SDK" — exactly the operations this
 * slice needs). Session messages and template messages are DISTINCT
 * methods, never unified into one "send anything" call — this is what
 * makes it structurally impossible for a booking-confirmation code path to
 * accidentally reuse marketing-template plumbing that doesn't exist.
 */
export interface CommunicationProvider {
  sendSessionMessage(config: OutboundProviderConfig, to: string, text: string): Promise<SendResult>;
  sendTemplateMessage(config: OutboundProviderConfig, to: string, template: TemplateRef): Promise<SendResult>;
}

export interface OutboundProviderConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Injectable for tests; defaults to the real global `fetch`. */
  fetchImpl?: typeof fetch;
}

const GRAPH_API_VERSION = 'v21.0';

/**
 * The only WhatsApp-specific outbound code (section 24 of the W2-ARCH
 * approval: "provider-specific code stays entirely behind
 * CommunicationProvider"). Verified request shape against current official
 * Meta documentation during CLINIC-W2B.
 */
export class WhatsAppCloudProvider implements CommunicationProvider {
  async sendSessionMessage(config: OutboundProviderConfig, to: string, text: string): Promise<SendResult> {
    return this.send(config, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } });
  }

  async sendTemplateMessage(config: OutboundProviderConfig, to: string, template: TemplateRef): Promise<SendResult> {
    return this.send(config, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.languageCode },
        components: template.bodyParameters.length ? [{ type: 'body', parameters: template.bodyParameters.map((text) => ({ type: 'text', text })) }] : undefined,
      },
    });
  }

  private async send(config: OutboundProviderConfig, body: unknown): Promise<SendResult> {
    const fetchImpl = config.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`https://graph.facebook.com/${GRAPH_API_VERSION}/${config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.accessToken}` },
        body: JSON.stringify(body),
      });
    } catch {
      throw new OutboundSendFailedError(true);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new OutboundSendFailedError(false);
    }

    if (!response.ok) {
      // Section 31: 5xx/429 are retryable at the caller's discretion; 4xx (bad recipient, rejected template) are not.
      throw new OutboundSendFailedError(response.status >= 500 || response.status === 429);
    }

    const messageId = extractMessageId(parsed);
    if (!messageId) throw new OutboundSendFailedError(false);
    return { externalMessageId: messageId };
  }
}

function extractMessageId(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const first = messages[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const id = (first as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}
