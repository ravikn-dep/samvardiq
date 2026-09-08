import type { VerifiedPrincipal } from './types.js';

/**
 * Anything originating from a browser, mobile app, HTTP Authorization
 * header, cookie, or any external caller is untrusted — including a
 * syntactically well-formed, decodable JWT. A decoded-but-unverified
 * token is still `UntrustedCredential`, never `VerifiedPrincipal`.
 */
export interface UntrustedCredential {
  readonly rawToken: string;
}

/**
 * Provider-neutral authentication boundary (ARCH-016 / ADR-IDENTITY-001
 * "Provider Portability"). An adapter's only job is: accept untrusted
 * credential material, perform real cryptographic/authoritative
 * verification, and either produce a VerifiedPrincipal or fail closed.
 *
 * An adapter MUST NOT: determine organization membership, determine
 * OWNER/MEMBER/VIEWER, determine ApproverRole, establish
 * TrustedOrganizationContext, or query business-domain data. That is
 * AuthorizationService's job (see authorizationService.ts) — the two
 * stay composed, not merged, so authentication and authorization remain
 * independently testable and replaceable.
 */
export interface IdentityProviderAdapter {
  readonly provider: string;
  verifyCredential(credential: UntrustedCredential): Promise<VerifiedPrincipal>;
}
