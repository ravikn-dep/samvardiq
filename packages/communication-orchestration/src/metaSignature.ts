import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verified against current official Meta documentation (developers.facebook.com,
 * checked during CLINIC-W2B, not remembered/assumed): Meta signs every webhook
 * POST body with HMAC-SHA256 over the App Secret, sent as
 * `X-Hub-Signature-256: sha256=<hex>`. Verification MUST use the raw request
 * body — never a re-serialized/parsed-then-restringified version, which can
 * differ in whitespace/key-order from what was actually signed.
 */
export function verifyMetaWebhookSignature(rawBody: string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const received = signatureHeader.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received.toLowerCase(), 'hex'));
}

/**
 * Verified webhook verification handshake (Meta's `GET` subscription
 * challenge): respond with `hub.challenge` verbatim only if `hub.mode ===
 * 'subscribe'` and `hub.verify_token` matches the configured token —
 * otherwise reject. Returns the challenge string to echo back, or `null` if
 * the handshake should be rejected.
 */
export function verifyMetaWebhookHandshake(query: { 'hub.mode'?: string; 'hub.verify_token'?: string; 'hub.challenge'?: string }, verifyToken: string): string | null {
  if (query['hub.mode'] !== 'subscribe') return null;
  if (query['hub.verify_token'] !== verifyToken) return null;
  return query['hub.challenge'] ?? null;
}
