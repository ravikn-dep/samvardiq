import type { SkillDefinition, SkillInvocation, SkillResult } from '../types.js';
import { GBP_PUBLIC_FACING_APPROVAL, makeRecommendation } from './shared.js';

/**
 * Healthcare Local Growth Expert (docs/skills/SKILL_REGISTRY.md: local-seo-manager,
 * FORK_AND_ADAPT). This is an original implementation of the healthcare adaptation
 * requirements listed in the registry — no upstream code is vendored. It reasons
 * over Google Business Profile / local-visibility evidence supplied by the caller
 * and never fabricates metrics that were not provided.
 *
 * Explicitly out of scope: fake/incentivized reviews, review manipulation,
 * fabricated testimonials, ranking guarantees, autonomous GBP edits — enforced
 * centrally by policy.ts, not duplicated here.
 */
export const healthcareLocalGrowthDefinition: SkillDefinition = {
  id: 'healthcare-local-growth',
  name: 'Healthcare Local Growth Expert',
  version: '0.1.0',
  domain: 'marketing',
  owningExecutive: 'CMO',
  description:
    'Analyzes Google Business Profile completeness, local visibility trends, and review activity for a healthcare organization and recommends improvements to GBP-to-enquiry-to-appointment performance.',
  capabilities: [
    'gbp_profile_completeness_analysis',
    'local_visibility_trend_analysis',
    'review_trend_analysis',
    'gbp_to_enquiry_opportunity_analysis',
  ],
  allowedInputs: ['organizationProfile', 'gbp'],
  allowedOutputs: ['findings', 'recommendations'],
  requiredEvidence: ['gbp'],
  riskLevel: 'moderate',
  approvalPolicy: GBP_PUBLIC_FACING_APPROVAL,
  source: {
    repository: 'alirezarezvani/claude-skills',
    commit: '19392f7a08264ed00486a251f5b2098321771f94',
  },
  sourceVersion: '19392f7a08264ed00486a251f5b2098321771f94',
  license: 'MIT',
  status: 'INTEGRATED',
};

export function healthcareLocalGrowthHandler(invocation: SkillInvocation): SkillResult {
  const { gbp } = invocation.context;
  const findings: string[] = [];
  const evidence: SkillResult['evidence'] = [];
  const recommendations: SkillResult['recommendations'] = [];
  const assumptions: string[] = [];
  const risks: string[] = [];

  if (!gbp) {
    findings.push(
      'No Google Business Profile evidence was provided; local visibility cannot be assessed.',
    );
    return {
      invocationId: invocation.invocationId,
      skillId: healthcareLocalGrowthDefinition.id,
      organizationId: invocation.organizationId,
      goalId: invocation.goalId,
      findings,
      evidence,
      confidence: 15,
      assumptions,
      risks: ['Recommending action without GBP evidence would be unsupported.'],
      recommendations,
      requiresApproval: false,
      generatedAt: new Date().toISOString(),
    };
  }

  evidence.push({ source: 'google_business_profile', description: 'GBP snapshot', period: gbp.period });

  let dataPoints = 0;

  if (gbp.discoverySearches) {
    dataPoints++;
    const { current, previous } = gbp.discoverySearches;
    const deltaPct = previous > 0 ? Math.round(((current - previous) / previous) * 100) : 0;
    if (deltaPct < 0) {
      findings.push(`Discovery searches declined ${Math.abs(deltaPct)}% vs. the prior period.`);
      recommendations.push(
        makeRecommendation({
          organizationId: invocation.organizationId,
          goalId: invocation.goalId,
          owningExecutive: 'CMO',
          originatingSkill: healthcareLocalGrowthDefinition.id,
          title: 'Reverse declining GBP discovery searches',
          recommendedAction:
            'Publish weekly GBP posts and refresh service descriptions/photos to re-engage local discovery search ranking; review after 4 weeks.',
          rationale: `Discovery searches fell ${Math.abs(deltaPct)}% (${previous} -> ${current}) for period ${gbp.period}, indicating reduced local visibility.`,
          evidence: [
            { source: 'google_business_profile', description: 'discoverySearches', period: gbp.period },
          ],
          confidence: 65,
          assumptions: ['Decline is not explained by a known seasonal pattern in available evidence.'],
          expectedImpact: 'Recover discovery search volume toward prior-period baseline.',
          effort: 'low',
          risk: 'low',
          dependencies: [],
          successMetric: 'Discovery searches (GBP Insights) trending back toward previous-period baseline.',
          approvalRequirement: GBP_PUBLIC_FACING_APPROVAL,
          reviewDate: fourWeeksFrom(gbp.period),
        }),
      );
    } else {
      findings.push(`Discovery searches are stable or improving (${deltaPct >= 0 ? '+' : ''}${deltaPct}%).`);
    }
  }

  if (typeof gbp.profileCompleteness === 'number') {
    dataPoints++;
    if (gbp.profileCompleteness < 90) {
      findings.push(`GBP profile completeness is ${gbp.profileCompleteness}%, below the 90% baseline.`);
      recommendations.push(
        makeRecommendation({
          organizationId: invocation.organizationId,
          goalId: invocation.goalId,
          owningExecutive: 'CMO',
          originatingSkill: healthcareLocalGrowthDefinition.id,
          title: 'Complete Google Business Profile information',
          recommendedAction:
            'Fill missing GBP fields (services, categories, photos, hours) to reach full profile completeness.',
          rationale: `Profile completeness is ${gbp.profileCompleteness}%; incomplete profiles reduce local discoverability and patient trust.`,
          evidence: [
            { source: 'google_business_profile', description: 'profileCompleteness', period: gbp.period },
          ],
          confidence: 80,
          assumptions: [],
          expectedImpact: 'Improved local search ranking signal and higher patient trust on profile view.',
          effort: 'low',
          risk: 'low',
          dependencies: [],
          successMetric: 'GBP profile completeness reaches 100%.',
          approvalRequirement: GBP_PUBLIC_FACING_APPROVAL,
        }),
      );
    } else {
      findings.push(`GBP profile completeness is ${gbp.profileCompleteness}%.`);
    }
  }

  if (typeof gbp.averageRating === 'number' && typeof gbp.reviewCount === 'number') {
    dataPoints++;
    findings.push(`Current review profile: ${gbp.reviewCount} reviews at ${gbp.averageRating.toFixed(1)} average rating.`);
    if (gbp.reviewResponseRateDays && gbp.reviewResponseRateDays > 7) {
      findings.push(`Average review response time is ${gbp.reviewResponseRateDays} days, above the 7-day target.`);
      recommendations.push(
        makeRecommendation({
          organizationId: invocation.organizationId,
          goalId: invocation.goalId,
          owningExecutive: 'CMO',
          originatingSkill: healthcareLocalGrowthDefinition.id,
          title: 'Reduce review response time',
          recommendedAction:
            'Assign a staff owner to respond to every new Google review within 48 hours using approved response templates.',
          rationale: `Average review response time is ${gbp.reviewResponseRateDays} days; slow responses reduce patient trust signals in local search.`,
          evidence: [
            { source: 'google_business_profile', description: 'reviewResponseRateDays', period: gbp.period },
          ],
          confidence: 60,
          assumptions: ['Response templates will be reviewed for tone before use.'],
          expectedImpact: 'Faster, more consistent review responses improve conversion of visibility into trust.',
          effort: 'low',
          risk: 'low',
          dependencies: [],
          successMetric: 'Average review response time under 48 hours.',
          approvalRequirement: GBP_PUBLIC_FACING_APPROVAL,
        }),
      );
    }
  }

  if (dataPoints === 0) {
    findings.push('GBP snapshot was provided but contained no analyzable metrics.');
    assumptions.push('No further assumptions were made in the absence of metrics.');
  }

  const confidence = dataPoints === 0 ? 20 : Math.min(90, 40 + dataPoints * 15);

  return {
    invocationId: invocation.invocationId,
    skillId: healthcareLocalGrowthDefinition.id,
    organizationId: invocation.organizationId,
    goalId: invocation.goalId,
    findings,
    evidence,
    confidence,
    assumptions,
    risks,
    recommendations,
    requiresApproval: recommendations.some((r) => r.requiresApproval),
    generatedAt: new Date().toISOString(),
  };
}

function fourWeeksFrom(period: string): string | undefined {
  const parsed = new Date(period);
  if (Number.isNaN(parsed.getTime())) return undefined;
  parsed.setDate(parsed.getDate() + 28);
  return parsed.toISOString().slice(0, 10);
}
