/**
 * Marketing Skill Router (PRD "Marketing Ops Router"). Maps a goal description
 * to the registered skill(s) that can address it. Never fabricates a skill —
 * an unmatched request escalates instead of guessing.
 */
export interface RouteResult {
  skillIds: string[];
  escalate: boolean;
  reason?: string;
}

const GBP_PATTERN = /google business profile|gbp\b|google maps|local visibility|local seo/i;
const CONVERSION_PATTERN = /convert|conversion|funnel|drop[- ]?off|(enquir|inquir)(y|ies).*(appointment|consultation|book)/i;
const OVERALL_PATTERN = /(overall|comprehensive|holistic|entire).*(marketing|performance)|assess.*marketing/i;

export function routeGoal(goalDescription: string): RouteResult {
  const isGbp = GBP_PATTERN.test(goalDescription);
  const isConversion = CONVERSION_PATTERN.test(goalDescription);
  const isOverall = OVERALL_PATTERN.test(goalDescription);

  if (isOverall) {
    return { skillIds: ['healthcare-local-growth', 'campaign-analytics'], escalate: false };
  }
  if (isGbp) {
    return { skillIds: ['healthcare-local-growth'], escalate: false };
  }
  if (isConversion) {
    return { skillIds: ['campaign-analytics'], escalate: false };
  }
  return {
    skillIds: [],
    escalate: true,
    reason: `No registered marketing skill matches this request: "${goalDescription}".`,
  };
}
