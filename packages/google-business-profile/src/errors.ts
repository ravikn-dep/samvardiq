import { CredentialError, CredentialStoreError } from '@samvardiq/platform-credentials';

/**
 * GBP-W1 errors. Every message is fixed; no error carries a Google response
 * body, token, authorization code, state, URL or underlying exception (no
 * `cause` is attached), so nothing can leak through logs or responses.
 */
export abstract class GbpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The deployment has no Google OAuth client configured; the rest of the API is unaffected. */
export class GbpNotConfiguredError extends GbpError {
  constructor() {
    super('Google Business Profile integration is not configured.');
  }
}

/** Startup refusal: a partially or wrongly configured integration. Names the variable, never its value. */
export class GbpConfigurationError extends GbpError {
  constructor(detail: string) {
    super(`Google Business Profile configuration is invalid: ${detail}.`);
  }
}

/** The requested redirect URI is not exactly one of the deployment's allow-listed URIs (O). */
export class GbpRedirectUriNotAllowedError extends GbpError {
  constructor() {
    super('That redirect URI is not allowed.');
  }
}

export class GbpInvalidRequestError extends GbpError {
  constructor() {
    super('Invalid request.');
  }
}

/** The user declined or cancelled on Google's consent screen (L), or Google returned an authorization error (P). */
export class GoogleAuthorizationDeniedError extends GbpError {
  constructor() {
    super('Google authorization was not granted.');
  }
}

/** Google refused the authorization code: unknown, expired, already used, or mismatched redirect/verifier (N, O, Q). */
export class GoogleAuthorizationRejectedError extends GbpError {
  constructor() {
    super('Google did not accept the authorization. Start again.');
  }
}

/** Granular consent: the Business Profile permission was not granted, so nothing is stored. */
export class GoogleScopeNotGrantedError extends GbpError {
  constructor() {
    super('The Google Business Profile permission was not granted.');
  }
}

/** Google is unreachable, timed out, or answered 5xx (AJ). */
export class GoogleUnavailableError extends GbpError {
  constructor() {
    super('Google is temporarily unavailable. Try again later.');
  }
}

/** Google answered 429 (AK). */
export class GoogleRateLimitedError extends GbpError {
  constructor() {
    super('Google is temporarily unavailable. Try again later.');
  }
}

/** Google answered a 4xx other than invalid_grant — typically a client/redirect configuration problem, never the user's fault. */
export class GoogleRequestRejectedError extends GbpError {
  constructor() {
    super('Google returned an unexpected response.');
  }
}

/** A malformed or unexpected provider response, including malformed resource names (R, AL). */
export class GoogleResponseInvalidError extends GbpError {
  constructor() {
    super('Google returned an unexpected response.');
  }
}

/** No PERSONAL account in accounts.list, so the Google account cannot be identified for G3's same-account rule. */
export class GoogleAccountUnidentifiedError extends GbpError {
  constructor() {
    super('Google returned an unexpected response.');
  }
}

/** Beyond the W1 discovery bounds (one account page, five location pages per account). */
export class GbpTooManyResourcesError extends GbpError {
  constructor() {
    super('This Google account has more Business Profile resources than this version supports.');
  }
}

/** G3: a different Google account than the connected one. Disconnect first. */
export class GoogleAccountMismatchError extends GbpError {
  constructor() {
    super('A different Google account is already connected. Disconnect it first.');
  }
}

export type GbpConflictKind = 'not_connected' | 'already_bound' | 'bound_elsewhere' | 'already_connected';

const CONFLICT_MESSAGES: Record<GbpConflictKind, string> = {
  not_connected: 'Connect an active Google Business Profile account first.',
  already_bound: 'This organization already has a bound location. Unbind it first.',
  bound_elsewhere: 'That location is already bound to another organization.',
  already_connected: 'A Google Business Profile connection is already being set up for this organization. Try again.',
};

export class GbpConflictError extends GbpError {
  constructor(readonly kind: GbpConflictKind) {
    super(CONFLICT_MESSAGES[kind]);
  }
}

/** AB/AC: the location is not among those discovered for this organization's current connection. */
export class GbpLocationNotAvailableError extends GbpError {
  constructor() {
    super('That location is not available to bind. Reconnect to refresh the list.');
  }
}

export interface ClassifiedGbpError {
  httpStatus: number;
  message: string;
}

/**
 * apps/api error-handler fallback (same pattern as classifyCommunicationError):
 * GBP and ARCH-020 credential errors → fixed client-safe responses. Denials
 * collapse to the codebase-wide 403 "Access denied.".
 */
export function classifyGbpError(error: unknown): ClassifiedGbpError | null {
  if (error instanceof GbpNotConfiguredError) return { httpStatus: 503, message: error.message };
  if (error instanceof GoogleUnavailableError || error instanceof GoogleRateLimitedError) return { httpStatus: 503, message: error.message };
  if (error instanceof GoogleRequestRejectedError || error instanceof GoogleResponseInvalidError || error instanceof GoogleAccountUnidentifiedError || error instanceof GbpTooManyResourcesError) {
    return { httpStatus: 502, message: error.message };
  }
  if (error instanceof GoogleAccountMismatchError || error instanceof GbpConflictError) return { httpStatus: 409, message: error.message };
  if (error instanceof GbpLocationNotAvailableError) return { httpStatus: 404, message: error.message };
  if (error instanceof GbpError) return { httpStatus: 400, message: error.message };
  if (error instanceof CredentialError) {
    switch (error.code) {
      case 'access_denied':
        return { httpStatus: 403, message: 'Access denied.' };
      case 'authorization_invalid':
        return { httpStatus: 400, message: error.message };
      case 'invalid_input':
        return { httpStatus: 400, message: 'Invalid request.' };
      case 'connection_not_found':
        return { httpStatus: 404, message: 'Not found.' };
      case 'connection_conflict':
        return { httpStatus: 409, message: 'Request conflicts with the current state of this resource.' };
      case 'key_unavailable':
      case 'key_ring_invalid':
        return { httpStatus: 503, message: 'Provider connections are temporarily unavailable.' };
      case 'store_failure':
        if ((error as CredentialStoreError).sqlState === '23505') return { httpStatus: 409, message: CONFLICT_MESSAGES.already_connected };
        return null;
      default:
        return null;
    }
  }
  return null;
}
