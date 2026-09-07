import type { ApprovalRecord, ApprovalRequest, ApprovalRequestStatus } from './types.js';

/**
 * Persistence boundary (PRD B9): an in-memory implementation behind an
 * interface so a future Data Layer (Postgres/Supabase/etc.) can implement
 * this same interface without any governance logic changing. No production
 * database is chosen or introduced here.
 *
 * There is deliberately no "updateRecord"/"deleteRecord" method — completed
 * ApprovalRecords are append-only (PRD B10 audit integrity).
 *
 * Async (DATA-W3): a Postgres-backed implementation is inherently
 * network-bound and cannot satisfy a synchronous interface. Every method
 * returns a Promise; the in-memory implementation below resolves
 * synchronously-computed values, so this is a mechanical, behavior-preserving
 * change, not a redesign.
 *
 * Organization-scoped reads (DATA-W3): getRequest/updateRequestStatus/
 * listRecords now take organizationId — this was the exact
 * getRecommendation(recommendationId)-shaped anti-pattern DATA-W1/ADR-DATA-001
 * warned against, and Row Level Security made it a hard requirement, not
 * just a style preference: Postgres needs the organization context *before*
 * it can even run the query. Every real caller already had organizationId in
 * scope at each call site (ApprovalDecisionInput/CancelApprovalRequestInput
 * both carry it), so this is additive hardening, not a capability loss.
 */
export interface ApprovalRepository {
  saveRequest(request: ApprovalRequest): Promise<void>;
  getRequest(organizationId: string, approvalRequestId: string): Promise<ApprovalRequest | undefined>;
  updateRequestStatus(organizationId: string, approvalRequestId: string, status: ApprovalRequestStatus, decidedAt: string): Promise<void>;
  appendRecord(record: ApprovalRecord): Promise<void>;
  listRecords(organizationId: string, approvalRequestId: string): Promise<ApprovalRecord[]>;
  /**
   * Atomically apply a terminal transition: persist the request's new
   * status/decidedAt AND append the corresponding ApprovalRecord as one
   * indivisible operation (ADR-DATA-001 "Approval Atomicity"). The
   * in-memory implementation below just sequences updateRequestStatus +
   * appendRecord (single-threaded, no real transaction needed); a
   * Postgres-backed implementation must wrap both writes in one DB
   * transaction — see packages/data-foundation/src/postgres/approvalRepository.ts.
   */
  recordDecision(request: ApprovalRequest, record: ApprovalRecord): Promise<void>;
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly records: ApprovalRecord[] = [];

  async saveRequest(request: ApprovalRequest): Promise<void> {
    this.requests.set(request.approvalRequestId, { ...request });
  }

  /** A request that exists but belongs to a different organization is treated as not found — mirrors RLS row-hiding. */
  async getRequest(organizationId: string, approvalRequestId: string): Promise<ApprovalRequest | undefined> {
    const request = this.requests.get(approvalRequestId);
    if (!request || request.organizationId !== organizationId) return undefined;
    return { ...request };
  }

  async updateRequestStatus(
    organizationId: string,
    approvalRequestId: string,
    status: ApprovalRequestStatus,
    decidedAt: string,
  ): Promise<void> {
    const request = this.requests.get(approvalRequestId);
    if (!request || request.organizationId !== organizationId) return;
    this.requests.set(approvalRequestId, { ...request, status, decidedAt });
  }

  async appendRecord(record: ApprovalRecord): Promise<void> {
    this.records.push(record);
  }

  async listRecords(organizationId: string, approvalRequestId: string): Promise<ApprovalRecord[]> {
    return this.records.filter(
      (record) => record.approvalRequestId === approvalRequestId && record.organizationId === organizationId,
    );
  }

  async recordDecision(request: ApprovalRequest, record: ApprovalRecord): Promise<void> {
    await this.updateRequestStatus(request.organizationId, request.approvalRequestId, request.status, request.decidedAt ?? record.decidedAt);
    await this.appendRecord(record);
  }
}
