import type {
  ActorRole,
  ApprovalDecisionType,
  ApprovalRecord,
  ApprovalRepository,
  ApprovalRequest,
  ApprovalRequestStatus,
} from '@samvardiq/approval-governance';
import { and, eq } from 'drizzle-orm';

import { ApprovalRequestConcurrencyError, DuplicateEntityError, ReferentialIntegrityViolation } from '../errors.js';
import type { ApprovalLevel, RiskLevel } from '../types.js';
import { pgErrorCode, withOrganizationContext, type Database } from './client.js';
import { approvalRecords, approvalRequests } from './schema.js';

/**
 * The Postgres-backed implementation of approval-governance's own
 * ApprovalRepository port (Session 2, unmodified). Only recordDecision does
 * anything Postgres-specific that the in-memory adapters can't: it wraps the
 * terminal status UPDATE and the ApprovalRecord INSERT in one real database
 * transaction, with the UPDATE's `WHERE status = 'PENDING'` clause acting as
 * an atomic compare-and-swap — see the method for the full concurrency
 * argument (PRD sections 12-13).
 */
export class PostgresApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Database) {}

  async saveRequest(request: ApprovalRequest): Promise<void> {
    return withOrganizationContext(this.db, request.organizationId, async (tx) => {
      try {
        await tx.insert(approvalRequests).values({
          organizationId: request.organizationId,
          approvalRequestId: request.approvalRequestId,
          goalId: request.goalId,
          recommendationId: request.recommendationId,
          requestedBy: request.requestedBy,
          requiredApprovalLevel: request.requiredApprovalLevel,
          risk: request.risk,
          reason: request.reason,
          status: request.status,
          expiresAt: request.expiresAt ? new Date(request.expiresAt) : undefined,
        });
      } catch (error) {
        const code = pgErrorCode(error);
        if (code === '23505') throw new DuplicateEntityError('ApprovalRequest', request.approvalRequestId);
        // 23503: FK to recommendations (no such recommendation in this org).
        // P0001: the approval_requests_goal_consistency trigger (goal_id mismatch).
        if (code === '23503' || code === 'P0001') {
          throw new ReferentialIntegrityViolation(
            `ApprovalRequest "${request.approvalRequestId}" failed referential integrity: ${errorMessage(error)}`,
          );
        }
        throw error;
      }
    });
  }

  async getRequest(organizationId: string, approvalRequestId: string): Promise<ApprovalRequest | undefined> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.organizationId, organizationId), eq(approvalRequests.approvalRequestId, approvalRequestId)));
      return row ? toApprovalRequest(row) : undefined;
    });
  }

  /** Standalone update — not used by ApprovalGovernance.decide() (which uses recordDecision for atomicity), kept for interface completeness. */
  async updateRequestStatus(
    organizationId: string,
    approvalRequestId: string,
    status: ApprovalRequestStatus,
    decidedAt: string,
  ): Promise<void> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      await tx
        .update(approvalRequests)
        .set({ status, decidedAt: new Date(decidedAt) })
        .where(and(eq(approvalRequests.organizationId, organizationId), eq(approvalRequests.approvalRequestId, approvalRequestId)));
    });
  }

  /** Standalone insert — not used by ApprovalGovernance.decide() (which uses recordDecision), kept for interface completeness and direct integrity tests. */
  async appendRecord(record: ApprovalRecord): Promise<void> {
    return withOrganizationContext(this.db, record.organizationId, async (tx) => {
      try {
        await tx.insert(approvalRecords).values(toRecordRow(record));
      } catch (error) {
        const code = pgErrorCode(error);
        if (code === '23505') throw new DuplicateEntityError('ApprovalRecord', record.approvalRecordId);
        if (code === '23503') {
          throw new ReferentialIntegrityViolation(
            `ApprovalRecord references unknown approval request "${record.approvalRequestId}".`,
          );
        }
        throw error;
      }
    });
  }

  async listRecords(organizationId: string, approvalRequestId: string): Promise<ApprovalRecord[]> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(approvalRecords)
        .where(and(eq(approvalRecords.organizationId, organizationId), eq(approvalRecords.approvalRequestId, approvalRequestId)));
      return rows.map(toApprovalRecord);
    });
  }

  /**
   * Atomic terminal transition (PRD section 12): ApprovalRequest.status ->
   * terminal AND the corresponding ApprovalRecord insert happen in exactly
   * one database transaction.
   *
   * The UPDATE's `WHERE status = 'PENDING'` clause is a compare-and-swap:
   * under READ COMMITTED (Postgres's default), a concurrent UPDATE on the
   * same row blocks until the first transaction commits, then re-evaluates
   * its WHERE clause against the now-committed row — which is no longer
   * 'PENDING' — so it matches zero rows instead of applying a second time.
   * "Zero rows updated" is therefore the reliable, deterministic signal that
   * this transaction lost a race (or the request was already decided by the
   * time it ran), and is treated as a hard failure: the whole transaction
   * (including the subsequent INSERT, which never happens) rolls back
   * automatically. No application-level lock is used or needed — Postgres's
   * own row lock is the only synchronization primitive here.
   */
  async recordDecision(request: ApprovalRequest, record: ApprovalRecord): Promise<void> {
    return withOrganizationContext(this.db, request.organizationId, async (tx) => {
      const updated = await tx
        .update(approvalRequests)
        .set({
          status: request.status,
          decidedAt: request.decidedAt ? new Date(request.decidedAt) : new Date(record.decidedAt),
        })
        .where(
          and(
            eq(approvalRequests.organizationId, request.organizationId),
            eq(approvalRequests.approvalRequestId, request.approvalRequestId),
            eq(approvalRequests.status, 'PENDING'),
          ),
        )
        .returning({ approvalRequestId: approvalRequests.approvalRequestId });

      if (updated.length !== 1) {
        throw new ApprovalRequestConcurrencyError(request.approvalRequestId);
      }

      try {
        await tx.insert(approvalRecords).values(toRecordRow(record));
      } catch (error) {
        const code = pgErrorCode(error);
        // 23505 here means approval_records_one_per_request already has a row
        // for this request — should be structurally unreachable given the
        // PENDING guard above, but if it ever happened, failing (and rolling
        // back the UPDATE too) is strictly safer than silently succeeding.
        if (code === '23505') throw new DuplicateEntityError('ApprovalRecord', record.approvalRecordId);
        throw error;
      }
    });
  }
}

function toRecordRow(record: ApprovalRecord) {
  return {
    organizationId: record.organizationId,
    approvalRecordId: record.approvalRecordId,
    approvalRequestId: record.approvalRequestId,
    goalId: record.goalId,
    recommendationId: record.recommendationId,
    requiredApprovalLevel: record.requiredApprovalLevel,
    decision: record.decision,
    approverId: record.approverId,
    approverRole: record.approverRole,
    rationale: record.rationale,
    requestedAt: new Date(record.requestedAt),
    decidedAt: new Date(record.decidedAt),
    previousState: record.previousState,
    resultingState: record.resultingState,
  };
}

function toApprovalRequest(row: typeof approvalRequests.$inferSelect): ApprovalRequest {
  return {
    approvalRequestId: row.approvalRequestId,
    organizationId: row.organizationId,
    goalId: row.goalId,
    recommendationId: row.recommendationId,
    requestedBy: row.requestedBy,
    requiredApprovalLevel: row.requiredApprovalLevel as ApprovalLevel,
    risk: row.risk as RiskLevel,
    reason: row.reason,
    status: row.status as ApprovalRequestStatus,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    decidedAt: row.decidedAt?.toISOString(),
  };
}

function toApprovalRecord(row: typeof approvalRecords.$inferSelect): ApprovalRecord {
  return Object.freeze({
    approvalRecordId: row.approvalRecordId,
    approvalRequestId: row.approvalRequestId,
    organizationId: row.organizationId,
    goalId: row.goalId,
    recommendationId: row.recommendationId,
    requiredApprovalLevel: row.requiredApprovalLevel as ApprovalLevel,
    decision: row.decision as ApprovalDecisionType,
    approverId: row.approverId,
    approverRole: row.approverRole as ActorRole,
    rationale: row.rationale ?? undefined,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt.toISOString(),
    previousState: row.previousState as ApprovalRequestStatus,
    resultingState: row.resultingState as ApprovalRequestStatus,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
