/**
 * Data Layer entities (SOSA Layer 8). Domain-neutral, organization-scoped.
 * No clinical/patient entities belong here — see docs/data/DATA_PERSISTENCE_REQUIREMENTS.md
 * "Future healthcare data classification" for what is deliberately deferred.
 *
 * ApprovalLevel/RiskLevel mirror the literal unions already established in
 * marketing-intelligence and approval-governance (Layer 6 Approval Levels) —
 * reused by value, not imported, to keep this package's src/ free of a
 * runtime dependency on either (see persistentApprovalRepository.ts, which
 * only ever does `import type` from approval-governance).
 */
export type ApprovalLevel = 1 | 2 | 3 | 4 | 5;
export type RiskLevel = 'low' | 'moderate' | 'high' | 'critical';

export type OrganizationStatus = 'active' | 'inactive';

export interface Organization {
  organizationId: string;
  organizationType: string;
  name: string;
  status: OrganizationStatus;
  createdAt: string;
  updatedAt: string;
}

export type GoalStatus = 'active' | 'completed' | 'archived';

/** Field names follow docs/04_Architecture.md Layer 4 "Goal Definition" (Owner Executive). */
export interface Goal {
  goalId: string;
  organizationId: string;
  title: string;
  description: string;
  status: GoalStatus;
  ownerExecutive?: string;
  createdAt: string;
  updatedAt: string;
}

/** Reuses marketing-intelligence's own RecommendationStatus values (not redefined, just repeated as a literal union). */
export type PersistedRecommendationStatus = 'Draft' | 'Ready for Approval' | 'Awaiting Clarification' | 'Rejected';

export interface EvidenceReference {
  source: string;
  description: string;
}

/**
 * The governance-relevant PROJECTION of a Recommendation Layer output — not
 * a second Recommendation domain model. Full rationale/assumptions/effort/
 * dependencies/successMetric stay owned by the Recommendation Layer
 * (marketing-intelligence); this only persists what Approval & Governance
 * and the audit chain actually need.
 */
export interface PersistedRecommendation {
  recommendationId: string;
  organizationId: string;
  goalId: string;
  owningExecutive: string;
  originatingSkill: string;
  title: string;
  status: PersistedRecommendationStatus;
  approvalRequirement: ApprovalLevel;
  risk: RiskLevel;
  evidenceReferences: EvidenceReference[];
  confidence: number;
  createdAt: string;
}

/** Structural shape of a Recommendation Layer output — matches marketing-intelligence's Recommendation without importing it. */
export interface RecommendationLike {
  recommendationId: string;
  organizationId: string;
  goalId: string;
  owningExecutive: string;
  originatingSkill: string;
  title: string;
  status: PersistedRecommendationStatus;
  approvalRequirement: ApprovalLevel;
  risk: RiskLevel;
  evidence: EvidenceReference[];
  confidence: number;
}

/** Projects a real Recommendation Layer output down to its persisted, governance-relevant form. */
export function toPersistedRecommendation(recommendation: RecommendationLike, createdAt = new Date().toISOString()): PersistedRecommendation {
  return {
    recommendationId: recommendation.recommendationId,
    organizationId: recommendation.organizationId,
    goalId: recommendation.goalId,
    owningExecutive: recommendation.owningExecutive,
    originatingSkill: recommendation.originatingSkill,
    title: recommendation.title,
    status: recommendation.status,
    approvalRequirement: recommendation.approvalRequirement,
    risk: recommendation.risk,
    evidenceReferences: recommendation.evidence.map((e) => ({ source: e.source, description: e.description })),
    confidence: recommendation.confidence,
    createdAt,
  };
}
