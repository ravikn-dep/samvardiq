import type { ApprovalRecord, ApprovalRequest, ApprovalRequestStatus } from './types.js';

/**
 * Persistence boundary (PRD B9): an in-memory implementation behind an
 * interface so a future Data Layer (Postgres/Supabase/etc.) can implement
 * this same interface without any governance logic changing. No production
 * database is chosen or introduced here.
 *
 * There is deliberately no "updateRecord"/"deleteRecord" method — completed
 * ApprovalRecords are append-only (PRD B10 audit integrity).
 */
export interface ApprovalRepository {
  saveRequest(request: ApprovalRequest): void;
  getRequest(approvalRequestId: string): ApprovalRequest | undefined;
  updateRequestStatus(approvalRequestId: string, status: ApprovalRequestStatus, decidedAt: string): void;
  appendRecord(record: ApprovalRecord): void;
  listRecords(approvalRequestId: string): ApprovalRecord[];
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly records: ApprovalRecord[] = [];

  saveRequest(request: ApprovalRequest): void {
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

  appendRecord(record: ApprovalRecord): void {
    this.records.push(record);
  }

  listRecords(approvalRequestId: string): ApprovalRecord[] {
    return this.records.filter((record) => record.approvalRequestId === approvalRequestId);
  }
}
