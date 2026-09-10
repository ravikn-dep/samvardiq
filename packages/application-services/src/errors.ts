import {
  DuplicateEntityError,
  ExpiredCredentialError,
  InactiveIdentityError,
  InvalidCredentialError,
  InvalidMembershipTransitionError,
  LastActiveOwnerViolationError,
  MembershipAdministrationForbiddenError,
  MembershipNotActiveError,
  MembershipNotFoundError,
  MembershipTransitionConcurrencyError,
  ProviderIdentityNotLinkedError,
  ProviderUnavailableError,
  ProviderVerificationFailureError,
  TargetIdentityUnavailableError,
  UnauthenticatedPrincipalError,
  UnknownIdentityError,
  UnknownOrganizationError,
} from '@samvardiq/identity-access';

export type ErrorClass = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'AUTH_PROVIDER_UNAVAILABLE' | 'CONFLICT' | 'INTERNAL';

export interface ClassifiedError {
  errorClass: ErrorClass;
  httpStatus: number;
  /** Fixed, generic, client-safe text — never derived from the original error's message. */
  message: string;
}

/**
 * Maps internal domain errors to a client-safe response shape (section 15).
 * Never includes the original error's message, provider subject, internal
 * identityId, SQL detail, RLS detail, or token contents (AF/AI) — every
 * branch returns one of a small set of fixed strings.
 *
 * Organization-not-found and no-membership are DELIBERATELY collapsed into
 * the same FORBIDDEN/403 response (see organizationAccess.ts) so a caller
 * cannot enumerate which organization IDs exist by comparing responses
 * (section 21 / adversarial case AD).
 */
export function classifyError(error: unknown): ClassifiedError {
  if (
    error instanceof InvalidCredentialError ||
    error instanceof ExpiredCredentialError ||
    error instanceof UnauthenticatedPrincipalError ||
    error instanceof ProviderVerificationFailureError
  ) {
    return { errorClass: 'UNAUTHENTICATED', httpStatus: 401, message: 'Authentication required.' };
  }

  if (error instanceof ProviderUnavailableError) {
    return { errorClass: 'AUTH_PROVIDER_UNAVAILABLE', httpStatus: 503, message: 'Authentication service is temporarily unavailable.' };
  }

  if (
    error instanceof UnknownOrganizationError ||
    error instanceof MembershipNotFoundError ||
    error instanceof MembershipNotActiveError ||
    error instanceof ProviderIdentityNotLinkedError ||
    error instanceof UnknownIdentityError ||
    error instanceof InactiveIdentityError ||
    error instanceof MembershipAdministrationForbiddenError ||
    error instanceof TargetIdentityUnavailableError
  ) {
    // IDENTITY-W7: MembershipAdministrationForbiddenError (not an OWNER) and
    // TargetIdentityUnavailableError (unknown/suspended/revoked target
    // identity) are collapsed into the same FORBIDDEN/403 as every other
    // denial here, for the identical non-enumeration reason already
    // established above — a caller must not be able to distinguish "you
    // lack authority" from "that identity doesn't exist" from "that
    // identity isn't eligible."
    return { errorClass: 'FORBIDDEN', httpStatus: 403, message: 'Access denied.' };
  }

  if (
    error instanceof DuplicateEntityError ||
    error instanceof InvalidMembershipTransitionError ||
    error instanceof LastActiveOwnerViolationError ||
    error instanceof MembershipTransitionConcurrencyError
  ) {
    // IDENTITY-W7: the request was authenticated and authorized, but
    // conflicts with the target's current state (already exists, an
    // invalid lifecycle transition, would remove the last ACTIVE OWNER, or
    // lost a concurrent compare-and-swap race) — 409 Conflict, never a
    // generic 500, and never the underlying SQL/constraint detail.
    return { errorClass: 'CONFLICT', httpStatus: 409, message: 'Request conflicts with the current state of this resource.' };
  }

  return { errorClass: 'INTERNAL', httpStatus: 500, message: 'Internal server error.' };
}
