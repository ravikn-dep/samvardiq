import { enforceHealthcareDataBoundary } from './dataBoundary.js';
import { routeGoal } from './marketingRouter.js';
import { checkRecommendationPolicy } from './policy.js';
import type { SkillRegistry } from './registry.js';
import type { MarketingContext, Recommendation, SkillResult } from './types.js';

export interface CMOGoalInput {
  organizationId: string;
  goalId: string;
  goalDescription: string;
  requestedBy: string;
  context: MarketingContext;
}

export interface RejectedRecommendation {
  recommendation: Recommendation;
  violations: string[];
}

export interface CMOOutcome {
  status: 'ok' | 'unsupported';
  organizationId: string;
  goalId: string;
  invokedSkills: string[];
  results: SkillResult[];
  recommendations: Recommendation[];
  rejectedRecommendations: RejectedRecommendation[];
  escalation?: { reason: string };
}

/**
 * CMO Executive Boundary (SOSA Layer 2, marketing domain). Receives
 * organization context + goal + evidence, decides which registered marketing
 * skill(s) to invoke via the router, consolidates their output into
 * Samvardiq recommendations, and enforces the healthcare data boundary and
 * recommendation policy gate before anything leaves this boundary.
 *
 * CMO never executes external actions — see PRD section 6 ("CMO MUST NOT
 * directly execute external actions"). There is no execute/automation code
 * path here by design.
 */
export class CMOExecutive {
  constructor(private readonly registry: SkillRegistry) {}

  evaluateGoal(input: CMOGoalInput): CMOOutcome {
    enforceHealthcareDataBoundary(input.context);

    const route = routeGoal(input.goalDescription);
    if (route.escalate) {
      return {
        status: 'unsupported',
        organizationId: input.organizationId,
        goalId: input.goalId,
        invokedSkills: [],
        results: [],
        recommendations: [],
        rejectedRecommendations: [],
        escalation: { reason: route.reason ?? 'Unsupported request.' },
      };
    }

    const results: SkillResult[] = route.skillIds.map((skillId) =>
      this.registry.invoke(skillId, {
        invocationId: crypto.randomUUID(),
        organizationId: input.organizationId,
        goalId: input.goalId,
        skillId,
        requestedBy: input.requestedBy,
        context: input.context,
        timestamp: new Date().toISOString(),
      }),
    );

    let invokedSkills = [...route.skillIds];

    if (route.skillIds.length > 1) {
      const synthesis = this.registry.invoke('cmo-advisor', {
        invocationId: crypto.randomUUID(),
        organizationId: input.organizationId,
        goalId: input.goalId,
        skillId: 'cmo-advisor',
        requestedBy: input.requestedBy,
        context: { ...input.context, priorResults: results },
        timestamp: new Date().toISOString(),
      });
      results.push(synthesis);
      invokedSkills = [...invokedSkills, 'cmo-advisor'];
    }

    const recommendations: Recommendation[] = [];
    const rejectedRecommendations: RejectedRecommendation[] = [];

    for (const result of results) {
      for (const recommendation of result.recommendations) {
        const check = checkRecommendationPolicy(recommendation);
        if (check.valid) {
          recommendations.push({ ...recommendation, status: 'Ready for Approval' });
        } else {
          rejectedRecommendations.push({
            recommendation: { ...recommendation, status: 'Rejected' },
            violations: check.violations,
          });
        }
      }
    }

    return {
      status: 'ok',
      organizationId: input.organizationId,
      goalId: input.goalId,
      invokedSkills,
      results,
      recommendations,
      rejectedRecommendations,
    };
  }
}
