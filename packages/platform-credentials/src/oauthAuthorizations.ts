import { createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';

import { and, eq, gt, lte } from 'drizzle-orm';
import type { TrustedOrganizationContext } from '@samvardiq/identity-access';

import { canAdministerProviderConnections } from './credentialService.js';
import { CredentialAccessDeniedError, InvalidCredentialInputError, OAuthAuthorizationInvalidError, sanitizeStoreErrors } from './errors.js';
import type { MasterKeyRing } from './keyRing.js';
import { withOrganizationContext, type Database } from './postgres/client.js';
import { providerOAuthAuthorizations as authorizations } from './postgres/schema.js';

export type OAuthPurpose = 'connect';

export interface BeginOAuthAuthorizationInput {
  provider: string;
  purpose: OAuthPurpose;
  /** Must already be one of the deployment's exact, allow-listed redirect URIs — the provider connector checks that; this only stores it. */
  redirectUri: string;
}

export interface OAuthAuthorizationStart {
  /** Opaque, unpredictable, single-use. Goes to the provider in the authorization URL; stored here only as its SHA-256. */
  state: string;
  /** PKCE S256 challenge for the authorization URL. */
  codeChallenge: string;
  expiresAt: string;
}

export interface ConsumedOAuthAuthorization {
  redirectUri: string;
  /** PKCE verifier for the token exchange. Server memory only — never stored, logged or returned to a client. */
  codeVerifier: string;
}

const IDENTIFIER = /^[a-z][a-z0-9_]{1,62}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TTL_MS = 10 * 60_000;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * GBP-W1 (Founder decisions G2/G4) — provider-neutral, single-use OAuth state.
 *
 * - Only a human OWNER may begin or complete an authorization, and completion
 *   matches the SAME human, organization, provider and purpose that began it.
 *   The organization comes from the caller's TrustedOrganizationContext, so
 *   RLS hides every other organization's authorizations; the state itself
 *   never confers authority.
 * - The state is 256 random bits; only its SHA-256 is stored.
 * - Consumption is one `DELETE … RETURNING` — atomic, so of two concurrent or
 *   replayed completions exactly one gets the row. Expired rows are refused.
 * - The PKCE verifier is never stored: it is HKDF(master key[version],
 *   organization ‖ authorization ID), so a database dump alone cannot yield
 *   it, and nothing secret is ever written for an authorization.
 */
export class ProviderOAuthAuthorizations {
  constructor(
    private readonly db: Database,
    private readonly keyRing: MasterKeyRing,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async begin(actor: TrustedOrganizationContext, input: BeginOAuthAuthorizationInput): Promise<OAuthAuthorizationStart> {
    if (!canAdministerProviderConnections(actor)) throw new CredentialAccessDeniedError();
    assertProvider(input.provider);
    assertPurpose(input.purpose);
    assertRedirectUri(input.redirectUri);

    const organizationId = actor.organizationId;
    const authorizationId = randomUUID();
    const keyVersion = this.keyRing.activeVersion;
    const state = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(this.#verifier(keyVersion, organizationId, authorizationId)).digest('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    await this.#tx(organizationId, async (tx) => {
      // Housekeeping: abandoned authorizations of this organization are dropped; they hold nothing secret either way.
      await tx.delete(authorizations).where(and(eq(authorizations.organizationId, organizationId), lte(authorizations.expiresAt, now)));
      await tx.insert(authorizations).values({
        organizationId,
        authorizationId,
        stateHash: sha256Hex(state),
        provider: input.provider,
        purpose: input.purpose,
        identityId: actor.identityId,
        redirectUri: input.redirectUri,
        keyVersion,
        createdAt: now,
        expiresAt,
      });
    });
    return { state, codeChallenge, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Single use. Unknown, replayed, expired, another organization's, another
   * human's, another provider's or another purpose's state are one
   * indistinguishable OAuthAuthorizationInvalidError. A different human of the
   * same organization cannot consume (and so cannot burn) the initiator's state.
   */
  async consume(actor: TrustedOrganizationContext, input: { provider: string; purpose: OAuthPurpose; state: string }): Promise<ConsumedOAuthAuthorization> {
    if (!canAdministerProviderConnections(actor)) throw new CredentialAccessDeniedError();
    assertProvider(input.provider);
    assertPurpose(input.purpose);
    if (typeof input.state !== 'string' || !STATE.test(input.state)) throw new OAuthAuthorizationInvalidError();

    const organizationId = actor.organizationId;
    const [row] = await this.#tx(organizationId, (tx) =>
      tx
        .delete(authorizations)
        .where(
          and(
            eq(authorizations.organizationId, organizationId),
            eq(authorizations.stateHash, sha256Hex(input.state)),
            eq(authorizations.identityId, actor.identityId),
            eq(authorizations.provider, input.provider),
            eq(authorizations.purpose, input.purpose),
            gt(authorizations.expiresAt, new Date()),
          ),
        )
        .returning(),
    );
    if (!row) throw new OAuthAuthorizationInvalidError();
    return { redirectUri: row.redirectUri, codeVerifier: this.#verifier(row.keyVersion, organizationId, row.authorizationId) };
  }

  /** 43 base64url characters (RFC 7636 minimum length, unreserved alphabet). A retired key version fails closed (key_unavailable). */
  #verifier(keyVersion: number, organizationId: string, authorizationId: string): string {
    const info = JSON.stringify(['samvardiq.oauth-pkce.v1', organizationId, authorizationId]);
    return Buffer.from(hkdfSync('sha256', this.keyRing.key(keyVersion), Buffer.alloc(0), info, 32)).toString('base64url');
  }

  #tx<T>(organizationId: string, work: Parameters<typeof withOrganizationContext<T>>[2]): Promise<T> {
    return sanitizeStoreErrors(() => withOrganizationContext(this.db, organizationId, work));
  }
}

function assertProvider(value: unknown): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new InvalidCredentialInputError('provider');
}

function assertPurpose(value: unknown): void {
  if (value !== 'connect') throw new InvalidCredentialInputError('purpose');
}

/** Defence in depth only: the allow-list match happens in the provider connector. */
function assertRedirectUri(value: unknown): void {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new InvalidCredentialInputError('redirectUri');
  }
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  if (typeof value !== 'string' || value.length > 2048 || url.hash || url.username || url.password || !(url.protocol === 'https:' || loopback)) {
    throw new InvalidCredentialInputError('redirectUri');
  }
}
