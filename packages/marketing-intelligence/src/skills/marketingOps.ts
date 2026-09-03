import type { SkillDefinition, SkillInvocation, SkillResult } from '../types.js';

/**
 * Marketing Ops (docs/skills/SKILL_REGISTRY.md: marketing-ops). Handles broad
 * marketing-operations requests that don't map to a specific specialist skill
 * yet (e.g. general campaign/content planning). It deliberately does not
 * invent a strategy — it points to which registered specialist skills can
 * produce evidence-based analysis for the parts of the request it can identify.
 */
export const marketingOpsDefinition: SkillDefinition = {
  id: 'marketing-ops',
  name: 'Marketing Ops',
  version: '0.1.0',
  domain: 'marketing',
  owningExecutive: 'CMO',
  description: 'Coordinates general marketing-operations requests that are not specific to GBP or funnel analysis.',
  capabilities: ['marketing_request_triage'],
  allowedInputs: ['organizationProfile'],
  allowedOutputs: ['findings'],
  requiredEvidence: [],
  riskLevel: 'low',
  approvalPolicy: 1,
  source: {
    repository: 'alirezarezvani/claude-skills',
    commit: '19392f7a08264ed00486a251f5b2098321771f94',
  },
  sourceVersion: '19392f7a08264ed00486a251f5b2098321771f94',
  license: 'MIT',
  status: 'INTEGRATED',
};

export function marketingOpsHandler(invocation: SkillInvocation): SkillResult {
  return {
    invocationId: invocation.invocationId,
    skillId: marketingOpsDefinition.id,
    organizationId: invocation.organizationId,
    goalId: invocation.goalId,
    findings: [
      'This request is broader than a single registered specialist skill covers.',
      'Available specialists for follow-up: healthcare-local-growth (GBP/local visibility), campaign-analytics (enquiry-to-consultation conversion).',
    ],
    evidence: [],
    confidence: 30,
    assumptions: [],
    risks: [],
    recommendations: [],
    requiresApproval: false,
    generatedAt: new Date().toISOString(),
  };
}
