/**
 * Identity, membership, and trusted-organization-context contracts
 * (ARCH-016 / ADR-IDENTITY-001). Provider-independent — nothing here
 * imports or assumes Supabase.
 *
 * Package boundary (deliberate): `organizationId` is treated as an
 * opaque, valid-elsewhere identifier. This package does not own an
 * `organizations` table and has no database foreign key into
 * `data-foundation`'s `organizations` table — cross-package integration
 * in this monorepo already happens at the TypeScript interface level
 * (see `PersistentApprovalRepository` implementing
 * `approval-governance`'s `ApprovalRepository` port), never at the
 * database-FK level, and this package follows that same precedent.
 */

export type PrincipalType = 'human' | 'service';
export type IdentityStatus = 'active' | 'suspended' | 'revoked';

/** Platform-global — NOT organization-scoped. One identity may belong to many organizations. */
export interface Identity {
  identityId: string;
  principalType: PrincipalType;
  displayName: string;
  status: IdentityStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Platform-global. `(provider, providerSubject)` uniquely resolves to at
 * most one `identityId` — the required invariant from ADR-IDENTITY-001.
 */
export interface IdentityProviderLink {
  identityId: string;
  provider: string;
  providerSubject: string;
  createdAt: string;
}

export type OrganizationRole = 'OWNER' | 'MEMBER' | 'VIEWER';
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

/**
 * Reuses approval-governance's own ApproverRole literal union by value
 * (same pattern already established in data-foundation) — not imported,
 * no runtime coupling to that package.
 */
export type ApproverRole = 'hr_manager' | 'marketing_manager' | 'operations_manager' | 'finance_manager' | 'clinic_director' | 'founder';

/**
 * Organization-scoped — the one table in this package RLS actually
 * applies to. `approverRole` is an OPTIONAL grant of existing governance
 * authority; it is never implied by `role` (ARCH-016 constraint 8).
 */
export interface OrganizationMembership {
  organizationId: string;
  identityId: string;
  role: OrganizationRole;
  approverRole?: ApproverRole;
  status: MembershipStatus;
  invitedBy?: string;
  createdAt: string;
  activatedAt?: string;
  suspendedAt?: string;
  revokedAt?: string;
  updatedAt: string;
}

/**
 * A principal already verified by an identity provider adapter (not
 * built this session — no Supabase SDK exists in this package). This
 * type must NEVER be constructed from unverified raw token claims in
 * production code; only a future Identity Adapter may produce one from
 * a real verified session. Tests construct these directly as fixtures —
 * that is expected and fine, but it is a deliberate reminder that this
 * interface carries no verification logic of its own.
 */
export interface VerifiedPrincipal {
  provider: string;
  providerSubject: string;
  verifiedAt: string;
}

/**
 * The only sanctioned organization-authority object (ARCH-016
 * constraint 4). Every field is derived server-side from a fresh
 * membership-repository read at resolution time — never from a
 * client-supplied claim. See AuthorizationService.resolveTrustedContext,
 * the only place this type is constructed.
 */
export interface TrustedOrganizationContext {
  readonly identityId: string;
  readonly organizationId: string;
  /** Deterministic, not a separate stored id — `${organizationId}::${identityId}`, same derivation style as the membership table's own composite key. */
  readonly membershipId: string;
  readonly role: OrganizationRole;
  /** Present only if this membership carries governance approval authority AND the identity is human — see resolver for the enforcement. */
  readonly approverRole?: ApproverRole;
  readonly principalType: PrincipalType;
  readonly establishedAt: string;
}
