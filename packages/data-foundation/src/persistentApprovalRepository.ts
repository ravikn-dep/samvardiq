import type { ApprovalRecord, ApprovalRepository, ApprovalRequest, ApprovalRequestStatus } from '@samvardiq/approval-governance';

import { DuplicateEntityError, OrganizationBoundaryViolation, ReferentialIntegrityViolation } from './errors.js';
import type { OrganizationRepository } from './organizationRepository.js';
import type { RecommendationRepository } from './recommendationRepository.js';

/**
 * Adapter, not a rewrite: implements approval-governance's own ApprovalRepository
 * port (Session 2, unmodified) with Data Foundation's referential integrity.
 * State-transition validity, authorization, and approval policy all stay in
 * ApprovalGovernance — this class only refuses to persist an ApprovalRequest
 * or ApprovalRecord that doesn't structurally belong to a real, same-
 * organization Recommendation/request. It never evaluates whether a decision
 * itself is valid.
 */
export class PersistentApprovalRepository implements ApprovalRepository {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly records: ApprovalRecord[] = [];

  constructor(
    private readonly organizations: OrganizationRepository,
    private readonly recommendations: RecommendationRepository,
  ) {}

  saveRequest(request: ApprovalRequest): void {
    if (!this.organizations.get(request.organizationId)) {
      throw new ReferentialIntegrityViolation(
        `ApprovalRequest references unknown organization "${request.organizationId}".`,
      );
    }
    const recommendation = this.recommendations.get(request.organizationId, request.recommendationId);
    if (!recommendation) {
      throw new ReferentialIntegrityViolation(
        `ApprovalRequest references recommendation "${request.recommendationId}" not found under organization "${request.organizationId}".`,
      );
    }
    if (recommendation.goalId !== request.goalId) {
      throw new ReferentialIntegrityViolation(
        `ApprovalRequest.goalId "${request.goalId}" does not match recommendation "${request.recommendationId}"'s goalId "${recommendation.goalId}".`,
      );
    }
    if (this.requests.has(request.approvalRequestId)) {
      throw new DuplicateEntityError('ApprovalRequest', request.approvalRequestId);
    }
    this.requests.set(request.approvalRequestId, { ...request });
  }

  getRequest(approvalRequestId: string): ApprovalRequest | undefined {
    const request = this.requests.get(approvalRequestId);
    return request ? { ...request } : undefined;
  }

  updateRequestStatus(approvalRequestId: string, status: ApprovalRequestStatus, decidedAt: string): void {
    const request = this.requests.get(approvalRequestId);
    if (!request) return;
    this.requests.set(approvalRequestId, { ...request, status, decidedAt });
  }

  /** Append-only by construction: no updateRecord/deleteRecord exists on this class or the port it implements. */
  appendRecord(record: ApprovalRecord): void {
    const request = this.requests.get(record.approvalRequestId);
    if (!request) {
      throw new ReferentialIntegrityViolation(
        `ApprovalRecord references unknown approval request "${record.approvalRequestId}".`,
      );
    }
    if (
      request.organizationId !== record.organizationId ||
      request.goalId !== record.goalId ||
      request.recommendationId !== record.recommendationId
    ) {
      throw new OrganizationBoundaryViolation(
        `ApprovalRecord organization/goal/recommendation does not match its approval request "${record.approvalRequestId}".`,
      );
    }
    this.records.push(record);
  }

  listRecords(approvalRequestId: string): ApprovalRecord[] {
    return this.records.filter((record) => record.approvalRequestId === approvalRequestId);
  }
}
