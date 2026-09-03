import type { ApprovalLevel, Recommendation } from '../types.js';

type NewRecommendation = Omit<
  Recommendation,
  'recommendationId' | 'requiresApproval' | 'status'
>;

/** Every skill-generated recommendation starts as Draft and pending CMO consolidation (Layer 5). */
export function makeRecommendation(input: NewRecommendation): Recommendation {
  return {
    ...input,
    recommendationId: crypto.randomUUID(),
    requiresApproval: input.approvalRequirement > 1,
    status: 'Draft',
  };
}

/** Approval Level 1 (Informational) never applies to a public-facing action; floor at 2. */
export const GBP_PUBLIC_FACING_APPROVAL: ApprovalLevel = 2;
export const PROCESS_CHANGE_APPROVAL: ApprovalLevel = 3;
