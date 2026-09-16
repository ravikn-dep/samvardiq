import type { PreferredLanguage, StructuredAdministrativeIntent } from './types.js';

/**
 * Provider-neutral AI boundary (Founder Decision 3 / section 18-19 of the
 * session brief). No vendor is named anywhere in this interface or in
 * anything that depends on it. The output is closed-schema
 * (`StructuredAdministrativeIntent`) — there is no field an interpreter
 * could use to name an operation, a handler, a tool, or a route; every
 * consumer only branches on the fixed `intent` enum.
 */
export interface CommunicationInterpreter {
  interpret(input: { text: string; previousLanguage?: PreferredLanguage }): Promise<StructuredAdministrativeIntent>;
}

const APPOINTMENT_KEYWORDS = /\b(appointment|book|booking|schedule|consult|visit|slot)\b/i;
const CONSULTANT_HINT = /\b(?:dr\.?|doctor)\s+([a-z]+)/i;
const DATE_HINT = /\b(today|tomorrow)\b/i;
const HINDI_MARK = /[ऀ-ॿ]/;
const TELUGU_MARK = /[ఀ-౿]/;

/**
 * Deterministic, vendor-free implementation (section 19: "Prefer designing
 * and testing the provider-neutral boundary with deterministic test
 * implementations first... If an actual external AI provider is required
 * to satisfy W2B: STOP before integrating it"). This slice's own
 * `APPOINTMENT_BOOK`/`UNKNOWN` vocabulary is narrow enough that a
 * deterministic classifier is a legitimate, non-placeholder implementation
 * — not a stub standing in for a vendor call. No patient content is ever
 * sent anywhere; everything happens in-process.
 */
export class DeterministicCommunicationInterpreter implements CommunicationInterpreter {
  async interpret(input: { text: string; previousLanguage?: PreferredLanguage }): Promise<StructuredAdministrativeIntent> {
    const languageDetected = detectLanguage(input.text, input.previousLanguage);
    if (APPOINTMENT_KEYWORDS.test(input.text)) {
      const consultantHint = CONSULTANT_HINT.exec(input.text)?.[1];
      const dateHint = DATE_HINT.exec(input.text)?.[1]?.toLowerCase();
      return { intent: 'APPOINTMENT_BOOK', languageDetected, confidence: 0.9, consultantHint, dateHint };
    }
    // Confident it does NOT match a known intent (distinct from being
    // genuinely uncertain) — deliberately above the policy's low-confidence
    // threshold, so this reaches the CLARIFY/handoff branches on its own
    // merits rather than always being pre-empted by the confidence gate.
    return { intent: 'UNKNOWN', languageDetected, confidence: 0.7 };
  }
}

function detectLanguage(text: string, previous: PreferredLanguage | undefined): PreferredLanguage {
  if (HINDI_MARK.test(text)) return 'hi-IN';
  if (TELUGU_MARK.test(text)) return 'te-IN';
  if (/^[\x00-\x7F]*$/.test(text)) return previous === 'hi-IN' || previous === 'te-IN' ? previous : 'en-IN';
  return previous ?? 'mixed';
}
