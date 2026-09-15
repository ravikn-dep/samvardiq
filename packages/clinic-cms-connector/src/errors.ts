/**
 * Normalized connector error taxonomy (section 21). Every error's `message`
 * is a fixed, client-safe string — never the raw CMS response body,
 * signature, secret, or SQL detail. Constructors accept an optional
 * `cause` for server-side logging only; nothing here exposes `cause` in a
 * way a caller could serialize back to a client (see `application-services`
 * for where these are mapped to HTTP responses via the existing
 * `classifyError` convention).
 */

abstract class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConnectorUnavailableError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The clinic system is temporarily unavailable.', true, cause);
  }
}

export class ConnectorAuthenticationError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The clinic connection could not be authenticated.', false, cause);
  }
}

export class ConnectorAuthorizationError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The clinic connection is not authorized for this operation.', false, cause);
  }
}

export class ConnectorConfigurationError extends ConnectorError {
  constructor(message = 'The clinic connection is not configured correctly.', cause?: unknown) {
    super(message, false, cause);
  }
}

export class ConnectorValidationError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The clinic system rejected this request as invalid.', false, cause);
  }
}

export class ExternalResourceNotFoundError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The requested clinic record was not found.', false, cause);
  }
}

export class SlotUnavailableError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The requested appointment slot is no longer available.', true, cause);
  }
}

export class IdempotencyConflictError extends ConnectorError {
  constructor(cause?: unknown) {
    super('This request conflicts with a previous request using the same idempotency key.', false, cause);
  }
}

export class ConnectorRateLimitedError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The clinic system is rate-limiting this connection.', true, cause);
  }
}

/** Malformed/unexpected CMS response shape, or a transport-level failure not otherwise classified. Fails closed — never propagates the raw body. */
export class ConnectorProtocolError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The clinic system returned an unexpected response.', false, cause);
  }
}

/** The connection has no active, enabled configuration for this organization, or is explicitly disabled. */
export class ConnectionNotFoundError extends ConnectorError {
  constructor(cause?: unknown) {
    super('No active clinic connection is configured for this organization.', false, cause);
  }
}

/** A write result could not be confirmed one way or the other (e.g. an ambiguous reschedule/cancel after a network failure) — never silently retried, never silently assumed to have failed. */
export class AmbiguousMutationOutcomeError extends ConnectorError {
  constructor(cause?: unknown) {
    super('The outcome of this clinic operation could not be confirmed. Verify the current state before retrying.', false, cause);
  }
}
