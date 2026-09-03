import type { FunnelStage, SkillDefinition, SkillInvocation, SkillResult } from '../types.js';
import { PROCESS_CHANGE_APPROVAL, makeRecommendation } from './shared.js';

/**
 * Campaign Analytics Expert (docs/skills/SKILL_REGISTRY.md: campaign-analytics,
 * WRAP_AND_REUSE). Reasons over the organization-scoped, non-clinical funnel
 * defined in SKILL_REGISTRY.md ("GBP visibility -> ... -> review"). When the
 * funnel evidence needed to answer a conversion question is missing, it says
 * so explicitly rather than inventing a number (PRD Scenario B requirement).
 */
export const campaignAnalyticsDefinition: SkillDefinition = {
  id: 'campaign-analytics',
  name: 'Campaign Analytics Expert',
  version: '0.1.0',
  domain: 'marketing',
  owningExecutive: 'CMO',
  description:
    'Analyzes the organization-scoped enquiry-to-appointment-to-consultation funnel to identify where conversion is being lost.',
  capabilities: ['funnel_dropoff_analysis', 'conversion_rate_analysis'],
  allowedInputs: ['organizationProfile', 'funnel'],
  allowedOutputs: ['findings', 'recommendations'],
  requiredEvidence: ['funnel'],
  riskLevel: 'low',
  approvalPolicy: PROCESS_CHANGE_APPROVAL,
  source: {
    repository: 'alirezarezvani/claude-skills',
    commit: '19392f7a08264ed00486a251f5b2098321771f94',
  },
  sourceVersion: '19392f7a08264ed00486a251f5b2098321771f94',
  license: 'MIT',
  status: 'INTEGRATED',
};

const FUNNEL_ORDER: FunnelStage[] = [
  'gbp_visibility',
  'interaction',
  'enquiry',
  'appointment_requested',
  'appointment_booked',
  'appointment_confirmed',
  'patient_attended',
  'consultation_completed',
  'follow_up',
  'review',
];

const MIN_CONSECUTIVE_STAGES_REQUIRED = 2;

export function campaignAnalyticsHandler(invocation: SkillInvocation): SkillResult {
  const { funnel, funnelPeriod } = invocation.context;
  const findings: string[] = [];
  const evidence: SkillResult['evidence'] = [];
  const recommendations: SkillResult['recommendations'] = [];
  const assumptions: string[] = [];

  const presentStages = FUNNEL_ORDER.filter((stage) => typeof funnel?.[stage] === 'number');
  const consecutivePairs = presentStages.reduce((count, stage, i) => {
    if (i === 0) return count;
    const prevStage = presentStages[i - 1];
    const prevIdx = FUNNEL_ORDER.indexOf(prevStage!);
    const curIdx = FUNNEL_ORDER.indexOf(stage);
    return curIdx === prevIdx + 1 ? count + 1 : count;
  }, 0);

  if (!funnel || consecutivePairs < MIN_CONSECUTIVE_STAGES_REQUIRED) {
    const missing = FUNNEL_ORDER.filter((stage) => !presentStages.includes(stage));
    findings.push(
      'Insufficient enquiry-to-consultation funnel data was provided to determine why enquiries are not converting.',
    );
    findings.push(`Required funnel stages not available: ${missing.join(', ')}.`);
    return {
      invocationId: invocation.invocationId,
      skillId: campaignAnalyticsDefinition.id,
      organizationId: invocation.organizationId,
      goalId: invocation.goalId,
      findings,
      evidence,
      confidence: 20,
      assumptions: [],
      risks: ['No conversion figure is reported because the underlying funnel data does not exist yet.'],
      recommendations,
      requiresApproval: false,
      generatedAt: new Date().toISOString(),
    };
  }

  evidence.push({ source: 'conversion_funnel', description: 'Enquiry-to-consultation funnel', period: funnelPeriod });

  let largestDrop: { from: FunnelStage; to: FunnelStage; dropPct: number } | undefined;
  for (let i = 0; i < presentStages.length - 1; i++) {
    const from = presentStages[i]!;
    const to = presentStages[i + 1]!;
    const fromCount = funnel[from]!;
    const toCount = funnel[to]!;
    if (fromCount <= 0) continue;
    const dropPct = Math.round(((fromCount - toCount) / fromCount) * 100);
    findings.push(`${from} -> ${to}: ${fromCount} -> ${toCount} (${dropPct}% drop-off).`);
    if (!largestDrop || dropPct > largestDrop.dropPct) largestDrop = { from, to, dropPct };
  }

  const totalVolume = funnel[presentStages[0]!] ?? 0;
  const lowVolume = totalVolume < 30;
  if (lowVolume) assumptions.push(`Sample size (${totalVolume}) is small; conversion rates may not be statistically stable.`);

  if (largestDrop && largestDrop.dropPct > 0) {
    recommendations.push(
      makeRecommendation({
        organizationId: invocation.organizationId,
        goalId: invocation.goalId,
        owningExecutive: 'CMO',
        originatingSkill: campaignAnalyticsDefinition.id,
        title: `Investigate ${largestDrop.from} -> ${largestDrop.to} drop-off`,
        recommendedAction: `Review the ${largestDrop.from} to ${largestDrop.to} handoff process (response time, follow-up script, staff ownership) for the largest drop-off in the funnel.`,
        rationale: `The largest conversion loss (${largestDrop.dropPct}%) occurs between ${largestDrop.from} and ${largestDrop.to}.`,
        evidence: [{ source: 'conversion_funnel', description: `${largestDrop.from}->${largestDrop.to}`, period: funnelPeriod }],
        confidence: lowVolume ? 45 : 70,
        assumptions: lowVolume ? [`Sample size (${totalVolume}) is small.`] : [],
        expectedImpact: `Reduced drop-off between ${largestDrop.from} and ${largestDrop.to}.`,
        effort: 'medium',
        risk: 'low',
        dependencies: [],
        successMetric: `${largestDrop.from}->${largestDrop.to} conversion rate improves period over period.`,
        approvalRequirement: PROCESS_CHANGE_APPROVAL,
      }),
    );
  }

  return {
    invocationId: invocation.invocationId,
    skillId: campaignAnalyticsDefinition.id,
    organizationId: invocation.organizationId,
    goalId: invocation.goalId,
    findings,
    evidence,
    confidence: lowVolume ? 45 : 70,
    assumptions,
    risks: [],
    recommendations,
    requiresApproval: recommendations.some((r) => r.requiresApproval),
    generatedAt: new Date().toISOString(),
  };
}
