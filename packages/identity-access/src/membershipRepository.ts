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
}
