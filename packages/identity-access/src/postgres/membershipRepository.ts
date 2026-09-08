import { and, eq } from 'drizzle-orm';

import { DuplicateEntityError, UnknownIdentityError } from '../errors.js';
import type { CreateMembershipInput, MembershipRepository } from '../membershipRepository.js';
import type { ApproverRole, MembershipStatus, OrganizationMembership, OrganizationRole } from '../types.js';
import { pgErrorCode, withOrganizationContext, type Database } from './client.js';
import { organizationMemberships } from './schema.js';

/** The one RLS-protected table in this package. Every method goes through withOrganizationContext. */
export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateMembershipInput): Promise<OrganizationMembership> {
    return withOrganizationContext(this.db, input.organizationId, async (tx) => {
      try {
        const status = input.status ?? 'INVITED';
        const now = status === 'ACTIVE' ? new Date() : undefined;
        const [row] = await tx
          .insert(organizationMemberships)
          .values({
            organizationId: input.organizationId,
            identityId: input.identityId,
            role: input.role,
            approverRole: input.approverRole,
            status,
            invitedBy: input.invitedBy,
            activatedAt: now,
          })
          .returning();
        return toMembership(row!);
      } catch (error) {
        const code = pgErrorCode(error);
        if (code === '23505') throw new DuplicateEntityError('OrganizationMembership', `${input.organizationId}::${input.identityId}`);
        if (code === '23503') throw new UnknownIdentityError(input.identityId);
        throw error;
      }
    });
  }

  async get(organizationId: string, identityId: string): Promise<OrganizationMembership | undefined> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(organizationMemberships)
        .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.identityId, identityId)));
      return row ? toMembership(row) : undefined;
    });
  }

  async updateStatus(organizationId: string, identityId: string, status: MembershipStatus): Promise<void> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const now = new Date();
      const patch: Partial<typeof organizationMemberships.$inferInsert> = { status, updatedAt: now };
      if (status === 'ACTIVE') patch.activatedAt = now;
      if (status === 'SUSPENDED') patch.suspendedAt = now;
      if (status === 'REVOKED') patch.revokedAt = now;
      await tx
        .update(organizationMemberships)
        .set(patch)
        .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.identityId, identityId)));
    });
  }
}

function toMembership(row: typeof organizationMemberships.$inferSelect): OrganizationMembership {
  return {
    organizationId: row.organizationId,
    identityId: row.identityId,
    role: row.role as OrganizationRole,
    approverRole: (row.approverRole ?? undefined) as ApproverRole | undefined,
    status: row.status as MembershipStatus,
    invitedBy: row.invitedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString(),
    suspendedAt: row.suspendedAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
