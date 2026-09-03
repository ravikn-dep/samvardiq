/**
 * Recommendation policy gate (PRD "Healthcare Local Growth Expert — Explicitly
 * exclude" list). Keyword-based and deterministic on purpose: this is a
 * governance boundary, not a content classifier — false negatives should be
 * closed by adding a pattern, not by adding ML.
 */

const BANNED_PATTERNS: RegExp[] = [
  /fake review/i,
  /incentiviz(e|ed|ing) review/i,
  /pay(ing)? (for )?(a )?review/i,
  /review manipulation/i,
  /buy reviews/i,
  /discount (for|in exchange for).*review/i,
  /free .*(for|in exchange for).*review/i,
  /fabricat(e|ed|ing) (a )?(patient )?testimonial/i,
  /guarantee(d)? (the )?(top |#1 |first |number one )?rank/i,
  /guaranteed ranking/i,
  /(automatically|without approval) (update|publish|post|edit) (the )?(gbp|google business profile|listing)/i,
];

export interface PolicyCheckResult {
  valid: boolean;
  violations: string[];
}

export function checkRecommendationPolicy(recommendation: {
  title: string;
  recommendedAction: string;
  rationale: string;
}): PolicyCheckResult {
  const text = `${recommendation.title} ${recommendation.recommendedAction} ${recommendation.rationale}`;
  const violations = BANNED_PATTERNS.filter((pattern) => pattern.test(text)).map(
    (pattern) => pattern.source,
  );
  return { valid: violations.length === 0, violations };
}
