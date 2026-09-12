import { DuplicateEntityError, UnknownIdentityError } from './errors.js';
import type { IdentityRepository } from './identityRepository.js';
import type { ApproverRole, MembershipStatus, OrganizationMembership, OrganizationRole } from './types.js';

export interface CreateMembershipInput {
  organizationId: string;
  identityId: string;
  role: OrganizationRole;
  approverRole?: ApproverRole;
  status?: MembershipStatus;
  invitedBy?: string;
}

/**
 * The one organization-scoped table in this package — same
 * `(organizationId, identityId)` composite-key discipline DATA-W3
 * already established and tested for its own tables (reused, not
 * reinvented; see ADR-IDENTITY-001 "Membership Model").
 */
export interface MembershipRepository {
  create(input: CreateMembershipInput): Promise<OrganizationMembership>;
  get(organizationId: string, identityId: string): Promise<OrganizationMembership | undefined>;
  updateStatus(organizationId: string, identityId: string, status: MembershipStatus): Promise<void>;
  /**
   * IDENTITY-W8 — self-discovery only: every membership row belonging to
   * this identityId, across ALL organizations. Never used to answer "who
   * else is in this organization" (that remains org-scoped, via `get`).
   * The Postgres implementation reads under `withIdentityContext`, a
   * NEW, separate RLS read-path from `withOrganizationContext` — see
   * postgres/client.ts and drizzle/0004_membership_self_discovery.sql for
   * the full reasoning on why this is safe (write policies are
   * completely unaffected; only SELECT gains a self-scoped OR-branch).
   */
  listByIdentity(identityId: string): Promise<OrganizationMembership[]>;
}

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly memberships = new Map<string, OrganizationMembership>();

  constructor(private readonly identities: IdentityRepository) {}

  private key(organizationId: string, identityId: string): string {
    return `${organizationId}::${identityId}`;
  }

  async create(input: CreateMembershipInput): Promise<OrganizationMembership> {
    if (!(await this.identities.get(input.identityId))) {
      throw new UnknownIdentityError(input.identityId);
    }
    const key = this.key(input.organizationId, input.identityId);
    if (this.memberships.has(key)) {
      throw new DuplicateEntityError('OrganizationMembership', key);
    }
    const now = new Date().toISOString();
    const status = input.status ?? 'INVITED';
    const membership: OrganizationMembership = {
      organizationId: input.organizationId,
      identityId: input.identityId,
      role: input.role,
      approverRole: input.approverRole,
      status,
      invitedBy: input.invitedBy,
      createdAt: now,
      activatedAt: status === 'ACTIVE' ? now : undefined,
      updatedAt: now,
    };
    this.memberships.set(key, membership);
    return { ...membership };
  }

  async get(organizationId: string, identityId: string): Promise<OrganizationMembership | undefined> {
    const membership = this.memberships.get(this.key(organizationId, identityId));
    return membership ? { ...membership } : undefined;
  }

  async updateStatus(organizationId: string, identityId: string, status: MembershipStatus): Promise<void> {
    const key = this.key(organizationId, identityId);
    const membership = this.memberships.get(key);
    if (!membership) return;
    const now = new Date().toISOString();
    const next: OrganizationMembership = { ...membership, status, updatedAt: now };
    if (status === 'ACTIVE') next.activatedAt = now;
    if (status === 'SUSPENDED') next.suspendedAt = now;
    if (status === 'REVOKED') next.revokedAt = now;
    this.memberships.set(key, next);
  }

  async listByIdentity(identityId: string): Promise<OrganizationMembership[]> {
    return [...this.memberships.values()].filter((m) => m.identityId === identityId).map((m) => ({ ...m }));
  }
}
