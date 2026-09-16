import type { HandoffTrigger, StructuredAdministrativeIntent } from './types.js';

export type PolicyAction = 'PROCEED' | 'CLARIFY' | 'HANDOFF';

export interface PolicyDecision {
  action: PolicyAction;
  handoffTrigger?: HandoffTrigger;
}

const LOW_CONFIDENCE_THRESHOLD = 0.5;
const MAX_CLARIFICATION_ATTEMPTS = 1;

/**
 * Deterministic, AI-output-is-never-authority gate (section 18/25). Takes
 * only the closed `StructuredAdministrativeIntent` shape and a plain
 * count — never re-reads raw message text, never lets the interpreter's
 * own field values change what this function decides beyond the fixed
 * `intent`/`confidence` fields it's built to read.
 */
export function evaluateCommunicationPolicy(intent: StructuredAdministrativeIntent, priorUnknownCount: number): PolicyDecision {
  if (intent.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { action: 'HANDOFF', handoffTrigger: 'LOW_CONFIDENCE' };
  }
  if (intent.intent === 'UNKNOWN') {
    return priorUnknownCount >= MAX_CLARIFICATION_ATTEMPTS ? { action: 'HANDOFF', handoffTrigger: 'UNKNOWN_AFTER_CLARIFICATION' } : { action: 'CLARIFY' };
  }
  return { action: 'PROCEED' };
}
