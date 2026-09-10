import { AuditMetadataValidationError, AuditReasonValidationError } from './errors.js';
import type { AuditMetadata } from './identityAuditEvent.js';

/**
 * Data minimization (section 31/15): a small, explicit allow-list, not a
 * denylist-only defense. Adding a new metadata key is a deliberate,
 * reviewable code change — not something a caller can introduce by simply
 * passing a new object shape. Kept to exactly what the one proof mutation
 * in this session (membership status transition) needs; grow only when a
 * real event type needs a new field, not speculatively.
 */
const ALLOWED_METADATA_KEYS = new Set(['fromStatus', 'toStatus', 'fromRole', 'toRole']);
const MAX_METADATA_KEYS = ALLOWED_METADATA_KEYS.size;
const MAX_METADATA_VALUE_LENGTH = 100;
const MAX_REASON_LENGTH = 500;

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SECRET_KEYWORDS = ['bearer ', 'password', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'jwt', 'credential'];
const CLINICAL_KEYWORDS = ['diagnosis', 'patient', 'medical', 'prescription', 'treatment', 'clinical', 'symptom'];

function containsKeyword(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

/**
 * Best-effort, not exhaustive: this cannot prove a string is safe, only
 * reject the shapes/keywords named here. Defense-in-depth alongside the
 * allow-list above (which already rejects anything not named), not a
 * replacement for it.
 */
function looksUnsafe(value: string): boolean {
  return JWT_SHAPE.test(value) || containsKeyword(value, SECRET_KEYWORDS) || containsKeyword(value, CLINICAL_KEYWORDS);
}

/** Section 14: reason must be bounded, safe, non-secret, non-clinical, never raw exception text. */
export function assertSafeReason(reason: string | undefined): void {
  if (reason === undefined) return;
  if (reason.length > MAX_REASON_LENGTH) {
    throw new AuditReasonValidationError(`reason exceeds ${MAX_REASON_LENGTH} characters`);
  }
  if (looksUnsafe(reason)) {
    throw new AuditReasonValidationError('reason contains a disallowed credential-like or clinical-like pattern');
  }
}

/** Section 15: strict allow-listed keys, primitive values only, bounded size — never an unrestricted metadata bag. */
export function assertSafeMetadata(metadata: AuditMetadata | undefined): void {
  if (metadata === undefined) return;
  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_KEYS) {
    throw new AuditMetadataValidationError(`metadata has ${keys.length} keys, exceeding the maximum of ${MAX_METADATA_KEYS}`);
  }
  for (const key of keys) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw new AuditMetadataValidationError(`metadata key "${key}" is not on the allow-list`);
    }
    const value = metadata[key];
    if (typeof value === 'string') {
      if (value.length > MAX_METADATA_VALUE_LENGTH) {
        throw new AuditMetadataValidationError(`metadata key "${key}" exceeds ${MAX_METADATA_VALUE_LENGTH} characters`);
      }
      if (looksUnsafe(value)) {
        throw new AuditMetadataValidationError(`metadata key "${key}" contains a disallowed credential-like or clinical-like pattern`);
      }
    }
  }
}
