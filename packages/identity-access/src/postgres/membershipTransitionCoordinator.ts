import { and, eq } from 'drizzle-orm';

import { assertSafeMetadata, assertSafeReason } from '../auditSafety.js';
import { MembershipTransitionConcurrencyError } from '../errors.js';
import type { AuditActor } from '../identityAuditEvent.js';
import type { MembershipStatus, OrganizationMembership, OrganizationRole } from '../types.js';
import { withOrganizationContext, type Database } from './client.js';
import { identityAuditEvents, organizationMemberships } from './schema.js';

export interface TransitionMembershipStatusInput {
  organizationId: string;
  identityId: string;
  /** Compare-and-swap guard — the transition is rejected (not silently forced) if the membership is not currently in this status. */
  expectedStatus: MembershipStatus;
  nextStatus: MembershipStatus;
  /**
   * Must come from server-established authority (a TrustedOrganizationContext
   * or an internal system caller) — never from arbitrary client input
   * (section 10/26). This coordinator does not and cannot verify that on its
   * own; it is the caller's responsibility, exactly as it already is for
   * every other place a TrustedOrganizationContext-shaped value is threaded
   * through this codebase.
   */
  actor: AuditActor;
  reason?: string;
  requestId?: string;
}

/**
 * Section 23/24 — the proof that a security-sensitive identity mutation and
 * its mandatory audit event commit as ONE atomic transaction. Deliberately
 * narrow: exactly one operation (membership status transition), not a
 * general membership-administration service, and not exposed through any
 * HTTP route (see the session report's "Proof Mutation" section for why
 * this does not define W7 product policy — this coordinator enforces NO
 * business rule about which transitions are "valid" beyond the
 * compare-and-swap on `expectedStatus`; a future membership-administration
 * service decides which transitions are actually permitted, and organization
 * role continues to carry no approval authority here, per ARCH-016).
 *
 * The compare-and-swap (`WHERE status = expectedStatus`) mirrors
 * data-foundation's `PostgresApprovalRepository.recordDecision` exactly —
 * see that method's doc comment for the full concurrency argument. Zero
 * rows updated is a hard failure: the whole transaction (including the
 * audit INSERT, which never runs) rolls back automatically, and Postgres's
 * own row lock is the only synchronization primitive, same as that
 * precedent.
 *
 * The audit INSERT runs on the SAME `tx` handle as the UPDATE — not through
 * `PostgresIdentityAuditRepository.append()` (which opens its own top-level
 * transaction) — precisely so both statements are one transaction, not a
 * transaction plus a nested one.
 */
export class PostgresMembershipTransitionCoordinator {
  constructor(private readonly db: Database) {}

  async transitionStatus(input: TransitionMembershipStatusInput): Promise<OrganizationMembership> {
    assertSafeReason(input.reason);

    return withOrganizationContext(this.db, input.organizationId, async (tx) => {
      const now = new Date();
      const patch: Partial<typeof organizationMemberships.$inferInsert> = { status: input.nextStatus, updatedAt: now };
      if (input.nextStatus === 'ACTIVE') patch.activatedAt = now;
      if (input.nextStatus === 'SUSPENDED') patch.suspendedAt = now;
      if (input.nextStatus === 'REVOKED') patch.revokedAt = now;

      const updated = await tx
        .update(organizationMemberships)
        .set(patch)
        .where(
          and(
            eq(organizationMemberships.organizationId, input.organizationId),
            eq(organizationMemberships.identityId, input.identityId),
            eq(organizationMemberships.status, input.expectedStatus),
          ),
        )
        .returning();

      if (updated.length !== 1) {
        // No audit row is written here. SUCCESS must never be recorded for a
        // mutation that did not happen (section 13/AA) — throwing here rolls
        // back the whole transaction, including the UPDATE attempt itself.
        throw new MembershipTransitionConcurrencyError(input.organizationId, input.identityId, input.expectedStatus);
      }

      const metadata = { fromStatus: input.expectedStatus, toStatus: input.nextStatus };
      assertSafeMetadata(metadata);

      // Reaching this line means the UPDATE above already applied (within
      // this same, not-yet-committed transaction) — SUCCESS is therefore
      // recorded only for a mutation that genuinely occurred, and if this
      // INSERT itself fails, the UPDATE above rolls back with it.
      await tx.insert(identityAuditEvents).values({
        eventId: crypto.randomUUID(),
        organizationId: input.organizationId,
        actorIdentityId: input.actor.principalType === 'system' ? undefined : input.actor.identityId,
        actorPrincipalType: input.actor.principalType,
        eventType: 'MEMBERSHIP_STATUS_CHANGED',
        targetType: 'MEMBERSHIP',
        targetId: `${input.organizationId}::${input.identityId}`,
        outcome: 'SUCCESS',
        reason: input.reason,
        requestId: input.requestId,
        metadata,
      });

      return toMembership(updated[0]!);
    });
  }
}

function toMembership(row: typeof organizationMemberships.$inferSelect): OrganizationMembership {
  return {
    organizationId: row.organizationId,
    identityId: row.identityId,
    role: row.role as OrganizationRole,
    approverRole: row.approverRole as OrganizationMembership['approverRole'],
    status: row.status as MembershipStatus,
    invitedBy: row.invitedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString(),
    suspendedAt: row.suspendedAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
