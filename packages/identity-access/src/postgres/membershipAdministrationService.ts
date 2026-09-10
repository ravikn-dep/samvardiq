import { and, asc, eq, or } from 'drizzle-orm';

import { assertSafeMetadata } from '../auditSafety.js';
import {
  DuplicateEntityError,
  InvalidMembershipTransitionError,
  LastActiveOwnerViolationError,
  MembershipAdministrationForbiddenError,
  MembershipNotFoundError,
  MembershipTransitionConcurrencyError,
  TargetIdentityUnavailableError,
} from '../errors.js';
import type { AuditEventType, AuditMetadata } from '../identityAuditEvent.js';
import type { IdentityRepository } from '../identityRepository.js';
import { isAllowedRoleChange, isAllowedStatusTransition } from '../membershipLifecycle.js';
import { canAdministerMembership } from '../membershipAdministrationPolicy.js';
import type { MembershipStatus, OrganizationMembership, OrganizationRole, TrustedOrganizationContext } from '../types.js';
import { pgErrorCode, withOrganizationContext, type Database } from './client.js';
import { identityAuditEvents, organizationMemberships } from './schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface CreateInvitedMembershipInput {
  targetIdentityId: string;
  role: OrganizationRole;
}

/**
 * IDENTITY-W7 — governed organization membership administration. Every
 * public method here:
 *
 * 1. Checks `canAdministerMembership(actor)` FIRST (section 14 — one
 *    centralized policy boundary, not `if (role === 'OWNER')` repeated
 *    per method).
 * 2. Runs entirely inside `withOrganizationContext(actor.organizationId, ...)`
 *    (reused unmodified from W2/W3 — never a second RLS mechanism).
 * 3. Locks the target membership row with `SELECT ... FOR UPDATE` before
 *    deciding anything — this is what makes concurrent conflicting
 *    operations (AJ/AK/AL/AM in the session's adversarial matrix)
 *    resolve to one truthful winner instead of a race: a second
 *    transaction touching the same row blocks until the first commits,
 *    then re-reads the now-current state rather than acting on stale data.
 * 4. Validates the transition against the fixed graph in
 *    membershipLifecycle.ts — never `status = <client value>` directly.
 * 5. The row lock (`lockTargetAndActiveOwners`) ALWAYS locks the target
 *    row together with every currently-ACTIVE-OWNER row in the
 *    organization, in ONE statement, ordered by `identityId` — never as
 *    two separate lock acquisitions. This is deliberate, not
 *    over-engineering: locking the target first and a potentially-
 *    overlapping "other owners" set second, in two statements, let two
 *    concurrent requests (e.g. Owner A suspending Owner B while Owner B
 *    simultaneously suspends Owner A) each hold one row and wait for the
 *    other — a genuine deadlock, reproduced during this session's own
 *    testing before this fix. A single, deterministically-ordered lock
 *    query makes every transaction request the same rows in the same
 *    order, so the second transaction simply blocks and waits instead of
 *    deadlocking — the standard fix for lock-ordering deadlocks, and
 *    exactly what section 24 means by "appropriate transaction/locking
 *    strategy."
 * 6. Writes the mutation and its mandatory `IdentityAuditEvent` on the
 *    SAME `tx` handle — one atomic transaction (reusing the exact pattern
 *    `PostgresMembershipTransitionCoordinator` proved in W6; built fresh
 *    here rather than calling into that class, matching this codebase's
 *    existing convention of self-contained atomic methods — see
 *    `PostgresApprovalRepository.recordDecision` for the same style).
 *
 * `actor` is always a `TrustedOrganizationContext` — never a raw
 * identityId/organizationId pair a caller could construct from request
 * input. `actor.organizationId` is what `withOrganizationContext` scopes
 * every operation to; a request body can never name a different
 * organization (section 15).
 */
export class PostgresMembershipAdministrationService {
  constructor(
    private readonly db: Database,
    private readonly identities: IdentityRepository,
  ) {}

  /**
   * Section 22: the target identity must already exist and be `active` —
   * `suspended`/`revoked` identities are not eligible to receive a NEW
   * membership (this check applies only to membership CREATION; it is
   * deliberately NOT re-applied to suspend/revoke operations on an
   * existing membership, since it must always remain possible to revoke
   * or suspend the membership of an identity that has since become
   * suspended/revoked at the platform level — blocking that would be a
   * lockout-prevention anti-pattern, not a safety feature).
   *
   * Section 9/10: `targetIdentityId` must already be a real, resolved
   * Samvardiq identity — this method never creates one, never resolves
   * one from an email or provider subject, and never auto-provisions
   * from Supabase authentication. See the session report's "Invitation /
   * Provisioning Model" for the explicit scope boundary this leaves.
   */
  async createInvitedMembership(
    actor: TrustedOrganizationContext,
    input: CreateInvitedMembershipInput,
    requestId?: string,
  ): Promise<OrganizationMembership> {
    if (!canAdministerMembership(actor)) throw new MembershipAdministrationForbiddenError();

    const targetIdentity = await this.identities.get(input.targetIdentityId);
    if (!targetIdentity || targetIdentity.status !== 'active') {
      throw new TargetIdentityUnavailableError();
    }

    return withOrganizationContext(this.db, actor.organizationId, async (tx) => {
      let row: typeof organizationMemberships.$inferSelect;
      try {
        const [inserted] = await tx
          .insert(organizationMemberships)
          .values({
            organizationId: actor.organizationId,
            identityId: input.targetIdentityId,
            role: input.role,
            status: 'INVITED',
          })
          .returning();
        row = inserted!;
      } catch (error) {
        if (pgErrorCode(error) === '23505') {
          throw new DuplicateEntityError('OrganizationMembership', `${actor.organizationId}::${input.targetIdentityId}`);
        }
        throw error;
      }

      await insertAuditEvent(tx, {
        organizationId: actor.organizationId,
        actor,
        eventType: 'MEMBERSHIP_CREATED',
        targetId: membershipTargetId(actor.organizationId, input.targetIdentityId),
        metadata: { toRole: input.role },
        requestId,
      });

      return toMembership(row);
    });
  }

  async activateMembership(actor: TrustedOrganizationContext, targetIdentityId: string, requestId?: string): Promise<OrganizationMembership> {
    return this.transitionStatus(actor, targetIdentityId, 'INVITED', 'ACTIVE', requestId);
  }

  async reactivateMembership(actor: TrustedOrganizationContext, targetIdentityId: string, requestId?: string): Promise<OrganizationMembership> {
    return this.transitionStatus(actor, targetIdentityId, 'SUSPENDED', 'ACTIVE', requestId);
  }

  async suspendMembership(actor: TrustedOrganizationContext, targetIdentityId: string, requestId?: string): Promise<OrganizationMembership> {
    return this.transitionStatus(actor, targetIdentityId, 'ACTIVE', 'SUSPENDED', requestId);
  }

  /** Revocable from any non-terminal state (INVITED, ACTIVE, or SUSPENDED) — no single `expectedFrom`, so `undefined` here means "whatever the graph in membershipLifecycle.ts allows into REVOKED." */
  async revokeMembership(actor: TrustedOrganizationContext, targetIdentityId: string, requestId?: string): Promise<OrganizationMembership> {
    return this.transitionStatus(actor, targetIdentityId, undefined, 'REVOKED', requestId);
  }

  async changeRole(actor: TrustedOrganizationContext, targetIdentityId: string, toRole: OrganizationRole, requestId?: string): Promise<OrganizationMembership> {
    if (!canAdministerMembership(actor)) throw new MembershipAdministrationForbiddenError();

    return withOrganizationContext(this.db, actor.organizationId, async (tx) => {
      const { target, activeOwners } = await lockTargetAndActiveOwners(tx, actor.organizationId, targetIdentityId);
      const fromRole = target.role as OrganizationRole;
      const currentStatus = target.status as MembershipStatus;

      if (!isAllowedRoleChange(currentStatus, fromRole, toRole)) {
        throw new InvalidMembershipTransitionError(
          `cannot change role from "${fromRole}" to "${toRole}" while membership status is "${currentStatus}"`,
        );
      }

      if (fromRole === 'OWNER' && toRole !== 'OWNER') {
        assertNotLastActiveOwner(activeOwners, targetIdentityId);
      }

      const [updated] = await tx
        .update(organizationMemberships)
        .set({ role: toRole, updatedAt: new Date() })
        .where(
          and(
            eq(organizationMemberships.organizationId, actor.organizationId),
            eq(organizationMemberships.identityId, targetIdentityId),
            eq(organizationMemberships.role, fromRole),
          ),
        )
        .returning();
      if (!updated) throw new MembershipTransitionConcurrencyError(actor.organizationId, targetIdentityId, fromRole);

      await insertAuditEvent(tx, {
        organizationId: actor.organizationId,
        actor,
        eventType: 'MEMBERSHIP_ROLE_CHANGED',
        targetId: membershipTargetId(actor.organizationId, targetIdentityId),
        metadata: { fromRole, toRole },
        requestId,
      });

      return toMembership(updated);
    });
  }

  private async transitionStatus(
    actor: TrustedOrganizationContext,
    targetIdentityId: string,
    expectedFrom: MembershipStatus | undefined,
    nextStatus: MembershipStatus,
    requestId?: string,
  ): Promise<OrganizationMembership> {
    if (!canAdministerMembership(actor)) throw new MembershipAdministrationForbiddenError();

    return withOrganizationContext(this.db, actor.organizationId, async (tx) => {
      const { target, activeOwners } = await lockTargetAndActiveOwners(tx, actor.organizationId, targetIdentityId);
      const fromStatus = target.status as MembershipStatus;

      if ((expectedFrom && fromStatus !== expectedFrom) || !isAllowedStatusTransition(fromStatus, nextStatus)) {
        throw new InvalidMembershipTransitionError(`cannot move from "${fromStatus}" to "${nextStatus}"`);
      }

      if (target.role === 'OWNER' && fromStatus === 'ACTIVE') {
        assertNotLastActiveOwner(activeOwners, targetIdentityId);
      }

      const now = new Date();
      const patch: Partial<typeof organizationMemberships.$inferInsert> = { status: nextStatus, updatedAt: now };
      if (nextStatus === 'ACTIVE') patch.activatedAt = now;
      if (nextStatus === 'SUSPENDED') patch.suspendedAt = now;
      if (nextStatus === 'REVOKED') patch.revokedAt = now;

      const [updated] = await tx
        .update(organizationMemberships)
        .set(patch)
        .where(
          and(
            eq(organizationMemberships.organizationId, actor.organizationId),
            eq(organizationMemberships.identityId, targetIdentityId),
            eq(organizationMemberships.status, fromStatus),
          ),
        )
        .returning();
      if (!updated) throw new MembershipTransitionConcurrencyError(actor.organizationId, targetIdentityId, fromStatus);

      await insertAuditEvent(tx, {
        organizationId: actor.organizationId,
        actor,
        eventType: 'MEMBERSHIP_STATUS_CHANGED',
        targetId: membershipTargetId(actor.organizationId, targetIdentityId),
        metadata: { fromStatus, toStatus: nextStatus },
        requestId,
      });

      return toMembership(updated);
    });
  }
}

type MembershipRow = typeof organizationMemberships.$inferSelect;

/**
 * Locks the target row AND every currently-ACTIVE-OWNER row in the
 * organization in ONE statement, ordered by `identityId` — see the class
 * doc comment (point 5) for why this must be a single combined lock
 * rather than two separate ones (deadlock avoidance under concurrent
 * last-owner-affecting operations).
 */
async function lockTargetAndActiveOwners(
  tx: Transaction,
  organizationId: string,
  targetIdentityId: string,
): Promise<{ target: MembershipRow; activeOwners: MembershipRow[] }> {
  const rows = await tx
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        or(
          eq(organizationMemberships.identityId, targetIdentityId),
          and(eq(organizationMemberships.role, 'OWNER'), eq(organizationMemberships.status, 'ACTIVE')),
        ),
      ),
    )
    .orderBy(asc(organizationMemberships.identityId))
    .for('update');

  const target = rows.find((r) => r.identityId === targetIdentityId);
  if (!target) throw new MembershipNotFoundError(organizationId, targetIdentityId);

  const activeOwners = rows.filter((r) => r.role === 'OWNER' && r.status === 'ACTIVE');
  return { target, activeOwners };
}

/**
 * Section 24/AO: `activeOwners` was locked together with the target row in
 * the SAME statement (see above) — so this check is safe against the exact
 * concurrent-mutual-removal race that a two-statement lock would deadlock
 * or race on. If no ACTIVE OWNER other than the target remains, the
 * target IS the last one — reject.
 */
function assertNotLastActiveOwner(activeOwners: MembershipRow[], excludingIdentityId: string): void {
  const others = activeOwners.filter((r) => r.identityId !== excludingIdentityId);
  if (others.length === 0) {
    throw new LastActiveOwnerViolationError();
  }
}

function membershipTargetId(organizationId: string, identityId: string): string {
  return `${organizationId}::${identityId}`;
}

async function insertAuditEvent(
  tx: Transaction,
  params: {
    organizationId: string;
    actor: TrustedOrganizationContext;
    eventType: AuditEventType;
    targetId: string;
    metadata: AuditMetadata;
    requestId?: string;
  },
): Promise<void> {
  assertSafeMetadata(params.metadata);
  await tx.insert(identityAuditEvents).values({
    eventId: crypto.randomUUID(),
    organizationId: params.organizationId,
    actorIdentityId: params.actor.identityId,
    actorPrincipalType: params.actor.principalType,
    eventType: params.eventType,
    targetType: 'MEMBERSHIP',
    targetId: params.targetId,
    outcome: 'SUCCESS',
    requestId: params.requestId,
    metadata: params.metadata,
  });
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
