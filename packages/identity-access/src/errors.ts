/** Every authorization failure fails closed via a distinct, catchable error type — never a silent success. */

export class UnauthenticatedPrincipalError extends Error {
  constructor() {
    super('No verified principal was supplied — a TrustedOrganizationContext cannot be established.');
    this.name = 'UnauthenticatedPrincipalError';
  }
}

/** No `identities` row exists for a given identityId — an integrity anomaly if reached via a provider link, since links should always point at a real identity. */
export class UnknownIdentityError extends Error {
  constructor(identityId: string) {
    super(`Identity "${identityId}" does not exist.`);
    this.name = 'UnknownIdentityError';
  }
}

export class InactiveIdentityError extends Error {
  constructor(identityId: string, status: string) {
    super(`Identity "${identityId}" is not active (status: "${status}").`);
    this.name = 'InactiveIdentityError';
  }
}

/**
 * Reserved for a future orchestration layer that can independently verify
 * organization existence (e.g. against data-foundation's own tables).
 * This package's own resolver never throws it — see types.ts's package
 * boundary note: identity-access has no way to distinguish "unknown
 * organization" from "no membership for this organization" on its own.
 */
export class UnknownOrganizationError extends Error {
  constructor(organizationId: string) {
    super(`Organization "${organizationId}" is not known to this service.`);
    this.name = 'UnknownOrganizationError';
  }
}

export class MembershipNotFoundError extends Error {
  constructor(organizationId: string, identityId: string) {
    super(`No membership exists for identity "${identityId}" in organization "${organizationId}".`);
    this.name = 'MembershipNotFoundError';
  }
}

export class MembershipNotActiveError extends Error {
  constructor(organizationId: string, identityId: string, status: string) {
    super(`Membership for identity "${identityId}" in organization "${organizationId}" is not active (status: "${status}").`);
    this.name = 'MembershipNotActiveError';
  }
}

/** For callers of a TrustedOrganizationContext that need a stronger role than it carries — not thrown by the resolver itself. */
export class InsufficientOrganizationAuthorityError extends Error {
  constructor(organizationId: string, identityId: string, role: string, required: string) {
    super(`Role "${role}" for identity "${identityId}" in organization "${organizationId}" does not satisfy the required "${required}".`);
    this.name = 'InsufficientOrganizationAuthorityError';
  }
}

/** The verified principal's (provider, providerSubject) has no linked Samvardiq identity yet — distinct from UnknownIdentityError (an identityId lookup miss). */
export class ProviderIdentityNotLinkedError extends Error {
  constructor(provider: string, providerSubject: string) {
    super(`No identity is linked to provider "${provider}" subject "${providerSubject}".`);
    this.name = 'ProviderIdentityNotLinkedError';
  }
}

/** For callers that require a specific principalType (e.g. "human only") — not thrown by AuthorizationService itself, which deliberately carries no business-domain authorization logic (see AuthorizationService's doc comment). */
export class InvalidPrincipalTypeError extends Error {
  constructor(identityId: string, actual: string, expected: string) {
    super(`Identity "${identityId}" has principalType "${actual}", but "${expected}" was required.`);
    this.name = 'InvalidPrincipalTypeError';
  }
}

export class DuplicateEntityError extends Error {
  constructor(entityType: string, id: string) {
    super(`${entityType} "${id}" already exists and cannot be created again.`);
    this.name = 'DuplicateEntityError';
  }
}

export class DuplicateProviderLinkError extends Error {
  constructor(provider: string, providerSubject: string) {
    super(`Provider "${provider}" subject "${providerSubject}" is already linked to an identity.`);
    this.name = 'DuplicateProviderLinkError';
  }
}

/**
 * IDENTITY-W3 — identity provider verification errors. None of these
 * constructors ever embed the raw credential/token value in the message
 * (see the security audit note in providers/supabaseIdentityProviderAdapter.ts) —
 * only a stable, non-sensitive reason string.
 */

/** The credential itself is structurally or cryptographically unacceptable — malformed, unsigned, wrong algorithm, wrong issuer, tampered signature, or missing a required claim. */
export class InvalidCredentialError extends Error {
  constructor(reason: string) {
    super(`Credential verification failed: ${reason}`);
    this.name = 'InvalidCredentialError';
  }
}

export class ExpiredCredentialError extends Error {
  constructor() {
    super('Credential has expired.');
    this.name = 'ExpiredCredentialError';
  }
}

/** The identity provider could not be reached (network/timeout) — never treated as a pass. */
export class ProviderUnavailableError extends Error {
  constructor(provider: string, reason: string) {
    super(`Identity provider "${provider}" is unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

/** A verification failure that isn't cleanly attributable to "bad credential" or "provider unreachable" — still fails closed. */
export class ProviderVerificationFailureError extends Error {
  constructor(provider: string, reason: string) {
    super(`Identity provider "${provider}" verification failed: ${reason}`);
    this.name = 'ProviderVerificationFailureError';
  }
}

export class ProviderConfigurationError extends Error {
  constructor(provider: string, reason: string) {
    super(`Identity provider "${provider}" is misconfigured: ${reason}`);
    this.name = 'ProviderConfigurationError';
  }
}

/**
 * IDENTITY-W6 — identity security audit. `reason`/`metadata` failed the
 * bounded-safety check in auditSafety.ts (too large, disallowed keyword/
 * shape, or an unrecognized metadata key). Thrown BEFORE any database
 * write is attempted.
 */
export class AuditReasonValidationError extends Error {
  constructor(reason: string) {
    super(`Audit event reason rejected: ${reason}`);
    this.name = 'AuditReasonValidationError';
  }
}

export class AuditMetadataValidationError extends Error {
  constructor(reason: string) {
    super(`Audit event metadata rejected: ${reason}`);
    this.name = 'AuditMetadataValidationError';
  }
}

/**
 * The membership status compare-and-swap (WHERE status = expectedStatus)
 * matched zero rows — either no such membership exists, or its status no
 * longer matches `expectedStatus` (lost a concurrent race, or was already
 * transitioned). Mirrors data-foundation's ApprovalRequestConcurrencyError
 * for the identical CAS-transaction failure shape. The whole transaction
 * (mutation AND its mandatory audit event) rolls back — no audit record is
 * ever created for a mutation that did not happen.
 */
export class MembershipTransitionConcurrencyError extends Error {
  constructor(organizationId: string, identityId: string, expectedStatus: string) {
    super(
      `Membership for identity "${identityId}" in organization "${organizationId}" was not "${expectedStatus}" at the moment of transition (lost a concurrent race or already transitioned).`,
    );
    this.name = 'MembershipTransitionConcurrencyError';
  }
}
