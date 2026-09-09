import {
  ExpiredCredentialError,
  InactiveIdentityError,
  InvalidCredentialError,
  MembershipNotActiveError,
  MembershipNotFoundError,
  ProviderIdentityNotLinkedError,
  ProviderUnavailableError,
  ProviderVerificationFailureError,
  UnauthenticatedPrincipalError,
  UnknownIdentityError,
  UnknownOrganizationError,
} from '@samvardiq/identity-access';

export type ErrorClass = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'AUTH_PROVIDER_UNAVAILABLE' | 'INTERNAL';

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
    error instanceof InactiveIdentityError
  ) {
    return { errorClass: 'FORBIDDEN', httpStatus: 403, message: 'Access denied.' };
  }

  return { errorClass: 'INTERNAL', httpStatus: 500, message: 'Internal server error.' };
}
