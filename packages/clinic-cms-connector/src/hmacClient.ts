import { createHmac } from 'node:crypto';

/**
 * Exact mirror of Clinic CMS's own signing algorithm — verified directly
 * against clinic-cms `87e3302a37ec104e5d07b7e9315f6eb690573e4b`,
 * `server/external/security.ts` (`createExternalRequestSignature`) and
 * `server/external/router.ts` (`authenticateExternalRequest`), not
 * inferred from documentation alone.
 *
 * Payload: `timestamp.requestId.METHOD.path.rawBody`, joined with `.`.
 * - `METHOD` is uppercased.
 * - `path` is the request path WITHOUT its query string — the CMS computes
 *   this as `req.originalUrl.split("?")[0]`, so query parameters (e.g.
 *   `?date=2026-08-13`) must never be included in the signed path even
 *   though they are sent on the wire.
 * - `rawBody` is the EXACT JSON string transmitted — `"{}"` for a body-less
 *   request (GET, or a POST with no meaningful body), never `undefined` or
 *   omitted from the joined string.
 * - Digest: HMAC-SHA256, lowercase hexadecimal (`createHmac` already
 *   produces lowercase hex via `.digest("hex")` — never uppercased).
 *
 * Critical rule (section 14): the caller must serialize the body exactly
 * once and pass that exact string here AND as the literal wire body — never
 * re-stringify independently for signing vs. sending, which risks
 * key-ordering or whitespace drift between the two.
 */
export function signClinicCmsRequest(input: {
  secret: string;
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  rawBody: string;
}): string {
  const pathWithoutQuery = input.path.split('?')[0]!;
  const payload = [input.timestamp, input.requestId, input.method.toUpperCase(), pathWithoutQuery, input.rawBody].join('.');
  return createHmac('sha256', input.secret).update(payload).digest('hex');
}
