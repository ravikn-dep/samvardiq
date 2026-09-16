import { MalformedProviderPayloadError } from './errors.js';

export interface InboundTextEvent {
  type: 'text';
  externalChannelId: string;
  externalContactId: string;
  externalMessageId: string;
  text: string;
  timestamp: string;
  /** From the payload's `contacts[].profile.name` — a provisional display name only, never treated as a verified patient identity (see bookingOrchestrator.ts's new-patient path). */
  contactDisplayName?: string;
}

export interface InboundStatusEvent {
  type: 'status';
  externalChannelId: string;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
}

export interface InboundUnsupportedEvent {
  type: 'unsupported';
  externalChannelId: string;
  externalContactId?: string;
  externalMessageId?: string;
}

export type InboundEvent = InboundTextEvent | InboundStatusEvent | InboundUnsupportedEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verified against current official Meta documentation (CLINIC-W2B):
 * `{ object, entry: [{ changes: [{ value: { metadata: { phone_number_id },
 * messages?: [...], statuses?: [...] } }] }] }`. One delivery can carry
 * multiple entries/changes/messages — this always returns a flat array, one
 * `InboundEvent` per message/status, never assuming exactly one.
 *
 * Whitelist parsing only (section 34/19 elsewhere in this codebase's own
 * convention): a message type this function doesn't recognize becomes
 * `unsupported`, never a thrown error and never silently dropped — the
 * caller (webhook ingress) decides how to acknowledge/handoff it.
 */
export function parseMetaWebhookEvents(rawBody: string): InboundEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new MalformedProviderPayloadError();
  }
  if (!isRecord(payload) || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    throw new MalformedProviderPayloadError();
  }

  const events: InboundEvent[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) continue;
      const value = change.value;
      const metadata = isRecord(value.metadata) ? value.metadata : undefined;
      const phoneNumberId = typeof metadata?.phone_number_id === 'string' ? metadata.phone_number_id : undefined;
      if (!phoneNumberId) continue;

      if (Array.isArray(value.messages)) {
        const contactNames = extractContactNames(value.contacts);
        for (const message of value.messages) {
          events.push(parseMessage(phoneNumberId, message, contactNames));
        }
      }
      if (Array.isArray(value.statuses)) {
        for (const status of value.statuses) {
          const parsed = parseStatus(phoneNumberId, status);
          if (parsed) events.push(parsed);
        }
      }
    }
  }
  return events;
}

function extractContactNames(rawContacts: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(rawContacts)) return names;
  for (const contact of rawContacts) {
    if (isRecord(contact) && typeof contact.wa_id === 'string' && isRecord(contact.profile) && typeof contact.profile.name === 'string') {
      names.set(contact.wa_id, contact.profile.name);
    }
  }
  return names;
}

function parseMessage(externalChannelId: string, raw: unknown, contactNames: Map<string, string>): InboundEvent {
  if (!isRecord(raw) || typeof raw.from !== 'string' || typeof raw.id !== 'string') {
    return { type: 'unsupported', externalChannelId };
  }
  if (raw.type === 'text' && isRecord(raw.text) && typeof raw.text.body === 'string') {
    return {
      type: 'text',
      externalChannelId,
      externalContactId: raw.from,
      externalMessageId: raw.id,
      text: raw.text.body,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
      contactDisplayName: contactNames.get(raw.from),
    };
  }
  return { type: 'unsupported', externalChannelId, externalContactId: raw.from, externalMessageId: raw.id };
}

const STATUS_VALUES = new Set(['sent', 'delivered', 'read', 'failed']);

function parseStatus(externalChannelId: string, raw: unknown): InboundStatusEvent | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.status !== 'string' || !STATUS_VALUES.has(raw.status)) return undefined;
  return {
    type: 'status',
    externalChannelId,
    externalMessageId: raw.id,
    status: raw.status as InboundStatusEvent['status'],
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
  };
}
