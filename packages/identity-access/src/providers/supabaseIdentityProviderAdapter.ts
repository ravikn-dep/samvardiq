import { createRemoteJWKSet, jwtVerify, type RemoteJWKSetOptions } from 'jose';
import { JOSEError } from 'jose/errors';

import {
  ExpiredCredentialError,
  InvalidCredentialError,
  ProviderConfigurationError,
  ProviderUnavailableError,
  ProviderVerificationFailureError,
} from '../errors.js';
import type { IdentityProviderAdapter, UntrustedCredential } from '../identityProviderAdapter.js';
import type { VerifiedPrincipal } from '../types.js';

const PROVIDER = 'supabase';

/**
 * Supabase JWTs currently carry no `aud` claim (confirmed against
 * Supabase's own JWT documentation as of this session — see the
 * IDENTITY-W3 report's "Supabase Guidance Verified" section for sources).
 * Audience validation is therefore genuinely not applicable here, not
 * silently skipped — there is nothing to check.
 */
const SUPPORTED_ALGORITHMS = ['ES256', 'RS256'];

export interface SupabaseAdapterConfig {
  /** e.g. "https://xyzcompany.supabase.co" — a project URL, never a secret. */
  projectUrl: string;
  /**
   * Passthrough to jose's own RemoteJWKSetOptions (timeout, headers, and —
   * primarily for tests — the `customFetch` symbol to substitute a fetch
   * implementation instead of hitting the network). Not required for
   * normal production use.
   */
  jwksOptions?: RemoteJWKSetOptions;
}

/**
 * Typed configuration boundary (fails closed on missing/malformed config,
 * never falls back to an insecure default). `SUPABASE_PROJECT_URL` is not
 * a secret — it's a project URL, safe to log/commit as a placeholder in
 * .env.example. No API key of any kind is read here; see the class doc
 * comment above for why none is required.
 */
export function loadSupabaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseAdapterConfig {
  const projectUrl = env.SUPABASE_PROJECT_URL;
  if (!projectUrl) {
    throw new ProviderConfigurationError(PROVIDER, 'SUPABASE_PROJECT_URL is not set');
  }
  return { projectUrl };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Verifies Supabase Auth access tokens by fetching the project's public
 * JWKS (`${projectUrl}/auth/v1/.well-known/jwks.json`) and checking the
 * token's signature, issuer, and expiration against it — the same
 * asymmetric-key verification path Supabase's own `getClaims()` SDK
 * method uses for projects on the current default (RSA/ES256) signing
 * keys. No Supabase SDK is used and no API key of any kind is required:
 * a JWKS endpoint is public by design (that is the entire point of
 * asymmetric keys), so this adapter needs only the project URL — no
 * service-role key, no anon/publishable key. Legacy HS256-signed
 * projects are not supported by this adapter (see the session report's
 * "Authentication Verification Strategy" for why that is a deliberate,
 * documented scope boundary, not an oversight).
 *
 * Known limitation, stated precisely rather than overclaimed: neither
 * this local JWKS verification NOR Supabase's own authoritative
 * `getUser()` check a live revocation list for an already-issued access
 * token — Supabase access tokens remain cryptographically valid until
 * their `exp` claim regardless of sign-out (confirmed against Supabase's
 * own public documentation/discussion of this exact behavior — see the
 * session report). This adapter proves "this token was validly issued by
 * this Supabase project and has not expired" — nothing more. The
 * compensating control is entirely downstream: AuthorizationService
 * re-checks Samvardiq's OWN identity/membership status fresh on every
 * resolution (IDENTITY-W2), which is what actually closes the window a
 * stolen-but-not-yet-expired token could exploit for organization access.
 */
export class SupabaseIdentityProviderAdapter implements IdentityProviderAdapter {
  readonly provider = PROVIDER;
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: SupabaseAdapterConfig) {
    if (!config.projectUrl || !isHttpsUrl(config.projectUrl)) {
      throw new ProviderConfigurationError(PROVIDER, 'projectUrl must be a valid https:// URL');
    }
    this.issuer = `${config.projectUrl.replace(/\/+$/, '')}/auth/v1`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`), config.jwksOptions);
  }

  async verifyCredential(credential: UntrustedCredential): Promise<VerifiedPrincipal> {
    if (!credential?.rawToken || typeof credential.rawToken !== 'string') {
      throw new InvalidCredentialError('missing or non-string token');
    }

    let sub: unknown;
    try {
      const { payload } = await jwtVerify(credential.rawToken, this.jwks, {
        issuer: this.issuer,
        algorithms: SUPPORTED_ALGORITHMS,
        requiredClaims: ['sub', 'exp', 'iss'],
      });
      sub = payload.sub;
    } catch (error) {
      throw mapVerificationError(error);
    }

    if (typeof sub !== 'string' || sub.length === 0) {
      throw new InvalidCredentialError('missing or invalid subject claim');
    }

    return Object.freeze({
      provider: PROVIDER,
      providerSubject: sub,
      verifiedAt: new Date().toISOString(),
    });
  }
}

/**
 * Maps jose's stable error `code` values to this package's own error
 * types — never re-throws jose's own error class directly (keeps
 * provider-specific error shapes from leaking past the adapter boundary,
 * same reasoning as keeping SDK types out of domain contracts). Never
 * includes the raw token in any message.
 */
function mapVerificationError(error: unknown): Error {
  if (error instanceof JOSEError) {
    switch (error.code) {
      case 'ERR_JWT_EXPIRED':
        return new ExpiredCredentialError();
      case 'ERR_JWKS_TIMEOUT':
        return new ProviderUnavailableError(PROVIDER, 'JWKS endpoint did not respond in time');
      case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      case 'ERR_JWKS_NO_MATCHING_KEY':
      case 'ERR_JOSE_ALG_NOT_ALLOWED':
      case 'ERR_JWT_INVALID':
      case 'ERR_JWS_INVALID':
        return new InvalidCredentialError(error.code);
      default:
        return new ProviderVerificationFailureError(PROVIDER, error.code);
    }
  }
  // A non-JOSE error reaching here is almost always the underlying JWKS
  // fetch itself failing (DNS, connection refused, etc.) — never treated
  // as anything other than "provider unreachable," never as a pass.
  return new ProviderUnavailableError(PROVIDER, error instanceof Error ? error.name : 'unknown error');
}
