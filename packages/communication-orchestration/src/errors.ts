/**
 * Domain errors for the communication boundary. Every message is fixed and
 * generic — never the raw webhook payload, signature, or secret.
 */
abstract class CommunicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Section 9/32.A/B: the webhook signature did not verify. */
export class InvalidWebhookSignatureError extends CommunicationError {
  constructor() {
    super('The webhook signature could not be verified.');
  }
}

/** Section 32.C: the payload's phone_number_id does not match any configured channel. */
export class UnknownChannelError extends CommunicationError {
  constructor() {
    super('No channel is configured for this provider event.');
  }
}

/** Section 32.D: the channel exists but is administratively disabled. */
export class ChannelDisabledError extends CommunicationError {
  constructor() {
    super('This communication channel is disabled.');
  }
}

/** Section 13/32.U/V: the same provider event was already processed. */
export class DuplicateProviderEventError extends CommunicationError {
  constructor() {
    super('This provider event has already been processed.');
  }
}

/** Section 34: the raw payload could not be parsed as a supported event shape. */
export class MalformedProviderPayloadError extends CommunicationError {
  constructor() {
    super('The provider payload could not be parsed.');
  }
}

/** Section 24/31: the outcome of an outbound send could not be confirmed. */
export class OutboundSendFailedError extends CommunicationError {
  constructor(public readonly retryable: boolean) {
    super('The outbound message could not be delivered.');
  }
}

/** CLINIC-W2C, section 8/18: the human handoff inbox is for human staff only — a service principal must never read it, even with an ACTIVE organization membership. */
export class HumanHandoffAccessForbiddenError extends CommunicationError {
  constructor() {
    super('This action requires a human staff principal.');
  }
}

/** CLINIC-W2C, section 20: an opaque pagination cursor that does not decode to the expected shape — never trusted, never used to bypass organization scoping, always rejected rather than guessed at. */
export class InvalidHandoffCursorError extends CommunicationError {
  constructor() {
    super('The pagination cursor is invalid.');
  }
}

/**
 * A deliberately separate classification surface, mirroring
 * `application-services`'s own `classifyClinicOperationsError` pattern
 * exactly (its own local error-class union, not the shared `ErrorClass`
 * — see that file's doc comment for why). Kept HERE rather than in
 * `application-services` because the dependency direction is the other
 * way around (`communication-orchestration` depends on
 * `application-services`, not the reverse), so `application-services`'s
 * own `classifyError` cannot import this package's error classes without
 * a circular dependency. `apps/api`'s error handler calls this as an
 * additional fallback, same as it already does for
 * `classifyClinicOperationsError`.
 */
export type CommunicationErrorClass = 'FORBIDDEN' | 'BAD_REQUEST' | 'INTERNAL';

export interface ClassifiedCommunicationError {
  errorClass: CommunicationErrorClass;
  httpStatus: number;
  message: string;
}

export function classifyCommunicationError(error: unknown): ClassifiedCommunicationError {
  if (error instanceof HumanHandoffAccessForbiddenError) {
    // Same non-enumerating FORBIDDEN/403 convention as every other
    // authorization denial in this codebase (application-services'
    // classifyError's own doc comment explains why: a caller must not be
    // able to distinguish "you lack authority" from any other denial).
    return { errorClass: 'FORBIDDEN', httpStatus: 403, message: 'Access denied.' };
  }
  if (error instanceof InvalidHandoffCursorError) {
    return { errorClass: 'BAD_REQUEST', httpStatus: 400, message: 'Invalid request.' };
  }
  return { errorClass: 'INTERNAL', httpStatus: 500, message: 'Internal server error.' };
}
