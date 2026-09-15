import { randomUUID } from 'node:crypto';

import {
  AmbiguousMutationOutcomeError,
  ConnectorAuthenticationError,
  ConnectorAuthorizationError,
  ConnectorProtocolError,
  ConnectorRateLimitedError,
  ConnectorUnavailableError,
  ConnectorValidationError,
  ExternalResourceNotFoundError,
  IdempotencyConflictError,
  SlotUnavailableError,
} from './errors.js';
import { signClinicCmsRequest } from './hmacClient.js';
import { backoffDelayMs, sleep, type RetryOptions } from './retryPolicy.js';

export interface ClinicCmsHttpClientConfig {
  baseUrl: string;
  keyId: string;
  secret: string;
  /** Injectable for tests; defaults to the real global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface CmsErrorEnvelope {
  requestId: string;
  error: { code: string; message: string; retryable: boolean };
}

function isCmsErrorEnvelope(value: unknown): value is CmsErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'object' &&
    (value as { error: { code?: unknown } }).error !== null &&
    typeof (value as { error: { code?: unknown } }).error.code === 'string'
  );
}

/**
 * How a network-level failure (no HTTP response received at all — DNS,
 * connection reset, timeout) should be handled for THIS specific call
 * (section 17):
 * - 'retry': safe to retry with a fresh signed attempt (reads, and writes
 *   that carry a stable Idempotency-Key).
 * - 'ambiguous': the CMS has no idempotency guard for this operation
 *   (reschedule, cancel) — a network failure here genuinely cannot tell us
 *   whether the mutation applied. Never silently retried.
 */
export type NetworkFailurePolicy = 'retry' | 'ambiguous';

export interface CmsRequestOptions {
  /** Full path including any query string, e.g. `/consultants/7/slots?date=2026-08-13`. Query string is sent on the wire but excluded from the HMAC signature — see hmacClient.ts. */
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
  retry?: RetryOptions;
  networkFailurePolicy: NetworkFailurePolicy;
}

/**
 * Low-level signed HTTP client for the Clinic CMS external API. Owns
 * exactly: building the signed request, one bounded retry loop, and
 * mapping the CMS's documented error envelope to normalized connector
 * errors. Knows nothing about Samvardiq organizations, connections, or
 * secrets — it is handed an already-resolved `{ baseUrl, keyId, secret }`
 * by the caller (see `ClinicOperationsConnector`).
 */
export class ClinicCmsHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ClinicCmsHttpClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async request<T>(options: CmsRequestOptions, parse: (raw: unknown) => T): Promise<T> {
    const attempts = options.retry?.maxAttempts ?? 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const raw = await this.attemptOnce(options);
        return parse(raw);
      } catch (error) {
        lastError = error;
        const isLastAttempt = attempt === attempts;
        if (isLastAttempt || !this.isRetryable(error)) throw error;
        if (options.retry) await sleep(backoffDelayMs(attempt, options.retry));
      }
    }
    // Unreachable in practice (the loop always returns or throws), kept for exhaustiveness.
    throw lastError instanceof Error ? lastError : new ConnectorProtocolError(lastError);
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof ConnectorUnavailableError || error instanceof ConnectorRateLimitedError;
  }

  /** Section 15/V/W: every attempt — including retries — generates a fresh request ID, timestamp, and signature. Never resends a previously-signed attempt. */
  private async attemptOnce(options: CmsRequestOptions): Promise<unknown> {
    const requestId = `sv_${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const rawBody = options.body === undefined ? '{}' : JSON.stringify(options.body);
    const signature = signClinicCmsRequest({
      secret: this.config.secret,
      timestamp,
      requestId,
      method: options.method,
      path: options.path,
      rawBody,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-external-key-id': this.config.keyId,
      'x-external-timestamp': timestamp,
      'x-external-signature': signature,
      'x-request-id': requestId,
    };
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${options.path}`, {
        method: options.method,
        headers,
        // Section 14: send the EXACT same string that was signed — never re-stringify.
        body: options.method === 'GET' ? undefined : rawBody,
      });
    } catch (cause) {
      if (options.networkFailurePolicy === 'ambiguous') throw new AmbiguousMutationOutcomeError(cause);
      throw new ConnectorUnavailableError(cause);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new ConnectorProtocolError(cause);
    }

    if (response.ok) return body;
    throw this.mapErrorResponse(response.status, body);
  }

  private mapErrorResponse(status: number, body: unknown): Error {
    const code = isCmsErrorEnvelope(body) ? body.error.code : undefined;
    switch (code) {
      case 'AUTH_REQUIRED':
      case 'AUTH_INVALID':
      case 'AUTH_STALE':
        return new ConnectorAuthenticationError(body);
      case 'SCOPE_FORBIDDEN':
        return new ConnectorAuthorizationError(body);
      case 'VALIDATION_ERROR':
        return new ConnectorValidationError(body);
      case 'NOT_FOUND':
        return new ExternalResourceNotFoundError(body);
      case 'SLOT_UNAVAILABLE':
        return new SlotUnavailableError(body);
      case 'IDEMPOTENCY_CONFLICT':
      case 'IDEMPOTENCY_IN_PROGRESS':
        return new IdempotencyConflictError(body);
      case 'RATE_LIMITED':
        return new ConnectorRateLimitedError(body);
      case 'REPLAY_DETECTED':
        // Section U: our own request-ID collided — never expected in normal
        // operation since every attempt generates a fresh one; treated as
        // non-retryable protocol confusion rather than silently retried.
        return new ConnectorProtocolError(body);
      default:
        if (status >= 500) return new ConnectorUnavailableError(body);
        return new ConnectorProtocolError(body);
    }
  }
}
