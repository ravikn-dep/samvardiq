/**
 * Samvardiq Skill Contract (SOSA Layer 3 — Domain Expert Layer, marketing domain)
 * and Recommendation Contract (SOSA Layer 5 — Recommendation Layer).
 *
 * Field names mirror the canonical structures already defined in
 * docs/04_Architecture.md ("Recommendation Structure", Layer 6 "Approval Levels")
 * rather than inventing a parallel schema.
 */

/** SKILL_REGISTRY.md status taxonomy. */
export type SkillStatus =
  | 'CANDIDATE'
  | 'AUDITED'
  | 'APPROVED'
  | 'INTEGRATED'
  | 'VALIDATED'
  | 'RETIRED';

export type RiskLevel = 'low' | 'moderate' | 'high' | 'critical';

/** Layer 6 — Approval & Governance Layer approval levels 1 (informational) - 5 (critical). */
export type ApprovalLevel = 1 | 2 | 3 | 4 | 5;

export interface SkillSource {
  repository: string;
  commit: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  version: string;
  domain: string;
  owningExecutive: string;
  description: string;
  capabilities: string[];
  allowedInputs: string[];
  allowedOutputs: string[];
  requiredEvidence: string[];
  riskLevel: RiskLevel;
  approvalPolicy: ApprovalLevel;
  source: SkillSource | 'internal';
  sourceVersion: string;
  license: string;
  status: SkillStatus;
}

export interface SkillInvocation {
  invocationId: string;
  organizationId: string;
  goalId: string;
  skillId: string;
  requestedBy: string;
  context: MarketingContext;
  timestamp: string;
}

export interface Evidence {
  source: string;
  description: string;
  period?: string;
}

export type RecommendationStatus =
  | 'Draft'
  | 'Ready for Approval'
  | 'Awaiting Clarification'
  | 'Rejected';

export type Effort = 'low' | 'medium' | 'high';

export interface Recommendation {
  recommendationId: string;
  organizationId: string;
  goalId: string;
  owningExecutive: string;
  originatingSkill: string;
  title: string;
  recommendedAction: string;
  rationale: string;
  evidence: Evidence[];
  confidence: number;
  assumptions: string[];
  expectedImpact: string;
  effort: Effort;
  risk: RiskLevel;
  dependencies: string[];
  successMetric: string;
  approvalRequirement: ApprovalLevel;
  requiresApproval: boolean;
  reviewDate?: string;
  status: RecommendationStatus;
}

export interface SkillResult {
  invocationId: string;
  skillId: string;
  organizationId: string;
  goalId: string;
  findings: string[];
  evidence: Evidence[];
  confidence: number;
  assumptions: string[];
  risks: string[];
  recommendations: Recommendation[];
  requiresApproval: boolean;
  generatedAt: string;
}

export interface PeriodComparison {
  current: number;
  previous: number;
}

/**
 * The four impression metrics of Google's Business Profile Performance API
 * (DailyMetric), named exactly as Google names them. Google counts multiple
 * impressions by one user within a day as one, so a period value is a sum of
 * daily values. Google withdrew the old "direct"/"discovery" search split
 * (QUERIES_DIRECT/QUERIES_INDIRECT) on 2023-03-30 with no replacement, so it
 * is not modelled here (Founder decision GBP-D8).
 */
export type GbpImpressionMetric =
  | 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'
  | 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
  | 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS'
  | 'BUSINESS_IMPRESSIONS_MOBILE_MAPS';

/** GBP evidence snapshot — supplied by the caller, never fabricated by a skill. */
export interface GbpSnapshot {
  period: string;
  /** Only the metrics Google actually returned for both periods; a missing metric is absent, never 0. */
  impressions?: Partial<Record<GbpImpressionMetric, PeriodComparison>>;
  /** Samvardiq-derived (not a Google metric). */
  profileCompleteness?: number;
  categories?: string[];
  servicesListed?: string[];
  reviewCount?: number;
  averageRating?: number;
  reviewResponseRateDays?: number;
}

export type FunnelStage =
  | 'gbp_visibility'
  | 'interaction'
  | 'enquiry'
  | 'appointment_requested'
  | 'appointment_booked'
  | 'appointment_confirmed'
  | 'patient_attended'
  | 'consultation_completed'
  | 'follow_up'
  | 'review';

export interface OrganizationProfile {
  id: string;
  name: string;
  specialty?: string;
  city?: string;
}

/**
 * Marketing intelligence input. Intentionally organization-scoped and
 * non-clinical — see enforceHealthcareDataBoundary in dataBoundary.ts.
 * The index signature allows arbitrary upstream fields through so the
 * boundary check has something real to scan and reject.
 */
export interface MarketingContext {
  organizationProfile?: OrganizationProfile;
  gbp?: GbpSnapshot;
  funnel?: Partial<Record<FunnelStage, number>>;
  funnelPeriod?: string;
  notes?: string;
  [key: string]: unknown;
}
