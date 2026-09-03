/**
 * Approval & Governance contract (SOSA Layer 6). Field names and the approval
 * level scale (1-5) mirror docs/04_Architecture.md Layer 6 "Approval Record"
 * and "Approval Levels" rather than inventing a parallel schema. Not
 * domain-specific: any Executive's Recommendation Layer output can flow
 * through this as long as it satisfies RecommendationRef structurally — this
 * package has no dependency on any single Executive's package.
 */

/** Layer 6 Approval Levels 1 (informational) - 5 (critical). Reused, not redefined. */
export type ApprovalLevel = 1 | 2 | 3 | 4 | 5;

export type RiskLevel = 'low' | 'moderate' | 'high' | 'critical';

/** Structural reference to a Recommendation Layer output — no import required from the producing package. */
export interface RecommendationRef {
  recommendationId: string;
  organizationId: string;
  goalId: string;
  approvalRequirement: ApprovalLevel;
  risk: RiskLevel;
  title: string;
}

export type ApprovalRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

/** Every non-PENDING value doubles as the ApprovalRecord.decision that produced it. */
export type ApprovalDecisionType = 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

/** Minimal role set (docs/04_Architecture.md Layer 6 "Role-Based Approval" — Typical approvers). */
export type ApproverRole =
  | 'hr_manager'
  | 'marketing_manager'
  | 'operations_manager'
  | 'finance_manager'
  | 'clinic_director'
  | 'founder';

/** The 'system' actor only ever appears on EXPIRED records — it never decides an approval. */
export type ActorRole = ApproverRole | 'system';

export interface Approver {
  id: string;
  organizationId: string;
  role: ApproverRole;
  /** 'ai' identities exist only to prove AI-self-approval is rejected — they can never decide. */
  kind: 'human' | 'ai';
}

export interface ApprovalRequest {
  approvalRequestId: string;
  organizationId: string;
  goalId: string;
  recommendationId: string;
  requestedBy: string;
  requiredApprovalLevel: ApprovalLevel;
  risk: RiskLevel;
  reason: string;
  status: ApprovalRequestStatus;
  createdAt: string;
  expiresAt?: string;
  decidedAt?: string;
}

export interface ApprovalDecisionInput {
  decision: 'APPROVED' | 'REJECTED';
  approverId: string;
  organizationId: string;
  rationale?: string;
}

/** Immutable audit history entry — see repository.ts: no update method is ever exposed for these. */
export interface ApprovalRecord {
  readonly approvalRecordId: string;
  readonly approvalRequestId: string;
  readonly organizationId: string;
  readonly goalId: string;
  readonly recommendationId: string;
  readonly requiredApprovalLevel: ApprovalLevel;
  readonly decision: ApprovalDecisionType;
  readonly approverId: string;
  readonly approverRole: ActorRole;
  readonly rationale: string | undefined;
  readonly requestedAt: string;
  readonly decidedAt: string;
  readonly previousState: ApprovalRequestStatus;
  readonly resultingState: ApprovalRequestStatus;
}
