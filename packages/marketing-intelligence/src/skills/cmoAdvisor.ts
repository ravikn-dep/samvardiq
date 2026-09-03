import type { SkillDefinition, SkillInvocation, SkillResult } from '../types.js';

/**
 * CMO Advisor (docs/skills/SKILL_REGISTRY.md: cmo-advisor). Consolidates
 * findings already produced by other specialist skills into one executive-level
 * summary — mirroring "CEO AI consolidates all recommendations" in
 * docs/04_Architecture.md Layer 2. It never introduces new findings of its
 * own; it only synthesizes what was already produced with evidence.
 */
export const cmoAdvisorDefinition: SkillDefinition = {
  id: 'cmo-advisor',
  name: 'CMO Advisor',
  version: '0.1.0',
  domain: 'marketing',
  owningExecutive: 'CMO',
  description: 'Synthesizes findings from multiple marketing specialist skills into one executive summary.',
  capabilities: ['multi_skill_synthesis'],
  allowedInputs: ['priorResults'],
  allowedOutputs: ['findings'],
  requiredEvidence: ['priorResults'],
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

export function cmoAdvisorHandler(invocation: SkillInvocation): SkillResult {
  const priorResults = (invocation.context.priorResults ?? []) as SkillResult[];
  const findings = priorResults.length
    ? [
        `Consolidated findings from ${priorResults.length} specialist skill(s): ${priorResults
          .map((r) => r.skillId)
          .join(', ')}.`,
        ...priorResults.flatMap((r) => r.findings),
      ]
    : ['No specialist findings were available to synthesize.'];

  const confidence = priorResults.length
    ? Math.round(priorResults.reduce((sum, r) => sum + r.confidence, 0) / priorResults.length)
    : 0;

  return {
    invocationId: invocation.invocationId,
    skillId: cmoAdvisorDefinition.id,
    organizationId: invocation.organizationId,
    goalId: invocation.goalId,
    findings,
    evidence: priorResults.flatMap((r) => r.evidence),
    confidence,
    assumptions: [],
    risks: [],
    recommendations: [],
    requiresApproval: false,
    generatedAt: new Date().toISOString(),
  };
}
