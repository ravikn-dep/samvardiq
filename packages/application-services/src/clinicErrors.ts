import {
  AmbiguousMutationOutcomeError,
  ConnectionNotFoundError,
  ConnectorAuthenticationError,
  ConnectorAuthorizationError,
  ConnectorConfigurationError,
  ConnectorProtocolError,
  ConnectorRateLimitedError,
  ConnectorUnavailableError,
  ConnectorValidationError,
  ExternalResourceNotFoundError,
  IdempotencyConflictError,
  SlotUnavailableError,
} from '@samvardiq/clinic-cms-connector';

/**
 * A deliberately separate classification surface from `errors.ts`'s
 * `classifyError` (section: "no unauthorized architecture change" — this
 * does not modify the existing identity/organization error taxonomy at
 * all). Every connector-layer failure here is a Samvardiq-side connection
 * problem (wrong credentials, insufficient CMS scope, CMS outage, our own
 * connection not configured) — never the CALLING Samvardiq user's fault —
 * so none of it is folded into the existing 401/403 "you are not
 * authorized" vocabulary that already carries a specific, different
 * meaning (organization/membership authorization) elsewhere in this
 * codebase.
 *
 * Every message is fixed and generic — never the raw CMS error message,
 * never a signature/secret/internal detail (section 21).
 */
export type ClinicErrorClass = 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'UPSTREAM_UNAVAILABLE' | 'INTERNAL';

export interface ClassifiedClinicError {
  errorClass: ClinicErrorClass;
  httpStatus: number;
  message: string;
}

export function classifyClinicOperationsError(error: unknown): ClassifiedClinicError {
  if (error instanceof ExternalResourceNotFoundError) {
    return { errorClass: 'NOT_FOUND', httpStatus: 404, message: 'The requested clinic record was not found.' };
  }

  if (error instanceof SlotUnavailableError || error instanceof IdempotencyConflictError) {
    return { errorClass: 'CONFLICT', httpStatus: 409, message: error.message };
  }

  if (
    error instanceof ConnectionNotFoundError ||
    error instanceof ConnectorConfigurationError ||
    error instanceof ConnectorUnavailableError ||
    error instanceof ConnectorAuthenticationError ||
    error instanceof ConnectorAuthorizationError ||
    error instanceof ConnectorRateLimitedError ||
    error instanceof ConnectorProtocolError ||
    error instanceof ConnectorValidationError ||
    error instanceof AmbiguousMutationOutcomeError
  ) {
    return { errorClass: 'UPSTREAM_UNAVAILABLE', httpStatus: 503, message: 'The clinic system is temporarily unavailable. Please try again shortly.' };
  }

  return { errorClass: 'INTERNAL', httpStatus: 500, message: 'Internal server error.' };
}
