import {
  InactiveIdentityError,
  MembershipNotActiveError,
  MembershipNotFoundError,
  ProviderIdentityNotLinkedError,
  UnauthenticatedPrincipalError,
  UnknownIdentityError,
} from './errors.js';
import type { Identity } from './types.js';
import type { IdentityRepository } from './identityRepository.js';
import type { IdentityProviderLinkRepository } from './providerLinkRepository.js';
import type { MembershipRepository } from './membershipRepository.js';
import type { OrganizationRole, TrustedOrganizationContext, VerifiedPrincipal } from './types.js';

export interface ResolveTrustedContextInput {
  /** Already provider-verified — never raw, unverified token claims. See VerifiedPrincipal's doc comment. */
  principal: VerifiedPrincipal;
  /** An input to authorization, not authorization itself (ARCH-016 constraint 5) — the caller is only ever asking "may I act as this organization?" */
  requestedOrganizationId: string;
}

/**
 * IDENTITY-W8 — deliberately NOT a TrustedOrganizationContext (section 7:
 * "authenticated internal identity ≠ trusted organization authority").
 * Carries no organizationId, no role, no approverRole — it answers only
 * "which organization am I eligible to select?", never "am I authorized
 * to act as this organization right now" (that remains
 * resolveTrustedContext's job alone, re-verified fresh on every
 * organization-scoped request regardless of what this list said).
 */
export interface EligibleOrganizationMembership {
  organizationId: string;
  role: OrganizationRole;
}

/**
 * The smallest authorization/context-resolution service required
 * (ADR-IDENTITY-001 "Authorization Service"). Resolves:
 *
 *   VerifiedPrincipal + requestedOrganizationId
 *     -> identity lookup -> identity ACTIVE?
 *     -> membership lookup -> membership ACTIVE?
 *     -> TrustedOrganizationContext
 *
 * Deliberately contains no business-domain authorization (no
 * appointment/marketing/CMS permission logic) — only identity and
 * membership resolution, exactly the boundary named in the ADR.
 *
 * Fail-closed on every branch: every early return is a thrown error,
 * never a partial or default context.
 */
export class AuthorizationService {
  constructor(
    private readonly identities: IdentityRepository,
    private readonly providerLinks: IdentityProviderLinkRepository,
    private readonly memberships: MembershipRepository,
  ) {}

  async resolveTrustedContext(input: ResolveTrustedContextInput): Promise<TrustedOrganizationContext> {
    const identity = await this.#resolveActiveIdentity(input.principal);

    const membership = await this.memberships.get(input.requestedOrganizationId, identity.identityId);
    if (!membership) throw new MembershipNotFoundError(input.requestedOrganizationId, identity.identityId);
    if (membership.status !== 'ACTIVE') {
      throw new MembershipNotActiveError(input.requestedOrganizationId, identity.identityId, membership.status);
    }

    return Object.freeze({
      identityId: identity.identityId,
      organizationId: input.requestedOrganizationId,
      membershipId: `${input.requestedOrganizationId}::${identity.identityId}`,
      role: membership.role,
      // A service principal can never carry approval authority through this
      // context, even if a membership row was somehow misconfigured with an
      // approverRole set — defense in depth beyond keeping service
      // principals out of the human onboarding path in the first place.
      approverRole: identity.principalType === 'human' ? membership.approverRole : undefined,
      principalType: identity.principalType,
      establishedAt: new Date().toISOString(),
    });
  }

  /**
   * IDENTITY-W8 — pre-organization discovery (section 7/8/10). Returns
   * only ACTIVE memberships for an ACTIVE identity — INVITED/SUSPENDED/
   * REVOKED memberships are never selectable access (section 10/I/J/K).
   *
   * Deliberately different failure contract from `resolveTrustedContext`:
   * this method NEVER throws for identity-resolution reasons (no
   * provider link, unknown identity, inactive identity) — it returns an
   * empty list instead. An unprovisioned/suspended/revoked identity must
   * look IDENTICAL to "provisioned, but genuinely zero eligible
   * organizations" (section 40, E/F/G: "gets no organizations," not "gets
   * denied") — this is the same non-enumeration posture already
   * established elsewhere in this system (e.g. "unknown organization"
   * and "no membership" collapsing to the same FORBIDDEN response in
   * application-services), applied here at the domain layer itself
   * rather than left to every caller to remember to collapse
   * individually. Only a genuine infrastructure failure (a repository
   * throwing for a reason unrelated to identity resolution) still
   * propagates.
   *
   * Never constructs, and is never used to construct, a
   * TrustedOrganizationContext — see EligibleOrganizationMembership's own
   * doc comment.
   */
  async listEligibleOrganizations(principal: VerifiedPrincipal): Promise<EligibleOrganizationMembership[]> {
    let identity: Identity;
    try {
      identity = await this.#resolveActiveIdentity(principal);
    } catch (error) {
      if (error instanceof ProviderIdentityNotLinkedError || error instanceof UnknownIdentityError || error instanceof InactiveIdentityError) {
        return [];
      }
      throw error;
    }
    const memberships = await this.memberships.listByIdentity(identity.identityId);
    return memberships.filter((m) => m.status === 'ACTIVE').map((m) => ({ organizationId: m.organizationId, role: m.role }));
  }

  /**
   * Shared identity-resolution steps: verified credential -> internal
   * identityId -> ACTIVE identity. A true JS private field (`#`), not
   * merely TypeScript `private` — it must not appear on the prototype at
   * all, so the reflection-based proof in test/resolver.test.ts ("no
   * bypass method exists on this boundary") continues to see only the
   * two real, intentional public entry points. Fails closed on every
   * branch, identical to resolveTrustedContext's own former first half
   * (extracted here so both callers share one code path, not two that
   * could silently drift apart).
   */
  async #resolveActiveIdentity(principal: VerifiedPrincipal): Promise<Identity> {
    if (!principal) throw new UnauthenticatedPrincipalError();

    const identityId = await this.providerLinks.findIdentityId(principal.provider, principal.providerSubject);
    if (!identityId) throw new ProviderIdentityNotLinkedError(principal.provider, principal.providerSubject);

    const identity = await this.identities.get(identityId);
    if (!identity) throw new UnknownIdentityError(identityId);
    if (identity.status !== 'active') throw new InactiveIdentityError(identityId, identity.status);

    return identity;
  }
}
