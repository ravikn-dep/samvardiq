import { ROLE_AUTHORITY, type ApproverDirectory } from './approverDirectory.js';
import {
  AiSelfApprovalError,
  ApprovalRequestExpiredError,
  ApprovalRequestNotFoundError,
  InsufficientAuthorityError,
  InvalidApprovalStateTransitionError,
  MissingRationaleError,
  RecommendationIntegrityError,
  UnknownApproverError,
} from './errors.js';
import type { ApprovalRepository } from './repository.js';
import type {
  ActorRole,
  ApprovalDecisionInput,
  ApprovalDecisionType,
  ApprovalRecord,
  ApprovalRequest,
  RecommendationRef,
} from './types.js';

export interface SubmitApprovalRequestInput {
  organizationId: string;
  goalId: string;
  recommendationId: string;
  requestedBy: string;
  recommendation: RecommendationRef;
  expiresAt?: string;
}

export interface CancelApprovalRequestInput {
  organizationId: string;
  cancelledBy: string;
  reason?: string;
}

/**
 * Approval & Governance Layer boundary (SOSA Layer 6). Terminates the flow at
 * Recommendation -> Approval Request -> Human Decision -> Approval Record.
 * There is no execute()/dispatch() method here and none should ever be
 * added to this class — execution is the Automation Engine's
 * responsibility (Layer 7), explicitly out of scope (PRD B1).
 */
export class ApprovalGovernance {
  constructor(
    private readonly repository: ApprovalRepository,
    private readonly approverDirectory: ApproverDirectory,
  ) {}

  async submitApprovalRequest(input: SubmitApprovalRequestInput): Promise<ApprovalRequest> {
    const { recommendation } = input;
    if (
      recommendation.organizationId !== input.organizationId ||
      recommendation.goalId !== input.goalId ||
      recommendation.recommendationId !== input.recommendationId
    ) {
      throw new RecommendationIntegrityError(
        `request(org=${input.organizationId}, goal=${input.goalId}, rec=${input.recommendationId}) vs ` +
          `recommendation(org=${recommendation.organizationId}, goal=${recommendation.goalId}, rec=${recommendation.recommendationId})`,
      );
    }

    const request: ApprovalRequest = {
      approvalRequestId: crypto.randomUUID(),
      organizationId: input.organizationId,
      goalId: input.goalId,
      recommendationId: recommendation.recommendationId,
      requestedBy: input.requestedBy,
      requiredApprovalLevel: recommendation.approvalRequirement,
      risk: recommendation.risk,
      reason: recommendation.title,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    };
    await this.repository.saveRequest(request);
    return request;
  }

  async getRequest(organizationId: string, approvalRequestId: string): Promise<ApprovalRequest | undefined> {
    return this.repository.getRequest(organizationId, approvalRequestId);
  }

  async listRecords(organizationId: string, approvalRequestId: string): Promise<ApprovalRecord[]> {
    return this.repository.listRecords(organizationId, approvalRequestId);
  }

  /**
   * Human decision on a PENDING request. Never triggers execution — returns an audit record only.
   *
   * DATA-W3: the request lookup is scoped to input.organizationId — a
   * request that exists but belongs to a different organization is
   * indistinguishable from one that doesn't exist at all (both produce
   * ApprovalRequestNotFoundError). This mirrors exactly what Row Level
   * Security does at the Postgres layer: a cross-organization row is
   * invisible, not merely "rejected" with a message that would leak its
   * existence. This subsumes the separate organizationId-mismatch and
   * approver-organization-mismatch checks this method used to make
   * explicitly (both are now structurally guaranteed by the org-scoped
   * getRequest/approverDirectory.find lookups themselves, so they were
   * removed as unreachable rather than left as dead code).
   */
  async decide(approvalRequestId: string, input: ApprovalDecisionInput): Promise<ApprovalRecord> {
    const request = await this.repository.getRequest(input.organizationId, approvalRequestId);
    if (!request) throw new ApprovalRequestNotFoundError(approvalRequestId);

    if (request.status !== 'PENDING') {
      throw new InvalidApprovalStateTransitionError(request.status, input.decision);
    }

    if (this.isExpired(request)) {
      await this.transitionAway(request, 'EXPIRED', { actorId: 'system', actorRole: 'system', rationale: 'Approval window elapsed.' });
      throw new ApprovalRequestExpiredError(approvalRequestId);
    }

    const approver = this.approverDirectory.find(input.organizationId, input.approverId);
    if (!approver) throw new UnknownApproverError(input.approverId);

    if (approver.kind === 'ai') {
      throw new AiSelfApprovalError(input.approverId);
    }

    const authorityLevel = ROLE_AUTHORITY[approver.role];
    if (authorityLevel < request.requiredApprovalLevel) {
      throw new InsufficientAuthorityError(approver.role, authorityLevel, request.requiredApprovalLevel);
    }

    if (input.decision === 'REJECTED' && !input.rationale) {
      throw new MissingRationaleError(approvalRequestId);
    }

    return this.transitionAway(request, input.decision, {
      actorId: approver.id,
      actorRole: approver.role,
      rationale: input.rationale,
    });
  }

  /**
   * Withdrawal of a still-pending request. Not a decision — no approver authority check.
   * Same organization-scoped lookup as decide() — see its doc comment.
   */
  async cancelApprovalRequest(approvalRequestId: string, input: CancelApprovalRequestInput): Promise<ApprovalRecord> {
    const request = await this.repository.getRequest(input.organizationId, approvalRequestId);
    if (!request) throw new ApprovalRequestNotFoundError(approvalRequestId);
    if (request.status !== 'PENDING') {
      throw new InvalidApprovalStateTransitionError(request.status, 'CANCELLED');
    }
    return this.transitionAway(request, 'CANCELLED', {
      actorId: input.cancelledBy,
      actorRole: 'system',
      rationale: input.reason,
    });
  }

  private isExpired(request: ApprovalRequest): boolean {
    return !!request.expiresAt && new Date(request.expiresAt).getTime() < Date.now();
  }

  /** The only place an ApprovalRecord is created — always frozen, always appended, never updated. */
  private async transitionAway(
    request: ApprovalRequest,
    decision: ApprovalDecisionType,
    actor: { actorId: string; actorRole: ActorRole; rationale?: string },
  ): Promise<ApprovalRecord> {
    const decidedAt = new Date().toISOString();
    const previousState = request.status;
    const resultingState = decision;

    const record: ApprovalRecord = Object.freeze({
      approvalRecordId: crypto.randomUUID(),
      approvalRequestId: request.approvalRequestId,
      organizationId: request.organizationId,
      goalId: request.goalId,
      recommendationId: request.recommendationId,
      requiredApprovalLevel: request.requiredApprovalLevel,
      decision,
      approverId: actor.actorId,
      approverRole: actor.actorRole,
      rationale: actor.rationale,
      requestedAt: request.createdAt,
      decidedAt,
      previousState,
      resultingState,
    });

    // One atomic operation, not two sequential calls: a Postgres-backed
    // repository wraps both writes in a single DB transaction (DATA-W3) —
    // see packages/data-foundation/src/postgres/approvalRepository.ts.
    await this.repository.recordDecision({ ...request, status: resultingState, decidedAt }, record);
    return record;
  }
}
