import {
  InactiveIdentityError,
  MembershipNotActiveError,
  MembershipNotFoundError,
  ProviderIdentityNotLinkedError,
  UnauthenticatedPrincipalError,
  UnknownIdentityError,
} from './errors.js';
import type { IdentityRepository } from './identityRepository.js';
import type { IdentityProviderLinkRepository } from './providerLinkRepository.js';
import type { MembershipRepository } from './membershipRepository.js';
import type { TrustedOrganizationContext, VerifiedPrincipal } from './types.js';

export interface ResolveTrustedContextInput {
  /** Already provider-verified — never raw, unverified token claims. See VerifiedPrincipal's doc comment. */
  principal: VerifiedPrincipal;
  /** An input to authorization, not authorization itself (ARCH-016 constraint 5) — the caller is only ever asking "may I act as this organization?" */
  requestedOrganizationId: string;
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
    if (!input.principal) throw new UnauthenticatedPrincipalError();

    const identityId = await this.providerLinks.findIdentityId(input.principal.provider, input.principal.providerSubject);
    if (!identityId) throw new ProviderIdentityNotLinkedError(input.principal.provider, input.principal.providerSubject);

    const identity = await this.identities.get(identityId);
    if (!identity) throw new UnknownIdentityError(identityId);
    if (identity.status !== 'active') throw new InactiveIdentityError(identityId, identity.status);

    const membership = await this.memberships.get(input.requestedOrganizationId, identityId);
    if (!membership) throw new MembershipNotFoundError(input.requestedOrganizationId, identityId);
    if (membership.status !== 'ACTIVE') {
      throw new MembershipNotActiveError(input.requestedOrganizationId, identityId, membership.status);
    }

    return Object.freeze({
      identityId,
      organizationId: input.requestedOrganizationId,
      membershipId: `${input.requestedOrganizationId}::${identityId}`,
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
}
