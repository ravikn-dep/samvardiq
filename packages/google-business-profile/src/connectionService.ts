import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TrustedOrganizationContext } from '@samvardiq/identity-access';
import {
  canAdministerProviderConnections,
  CredentialAccessDeniedError,
  CredentialStoreError,
  type ExternalProviderConnection,
  type ProviderCredentialService,
  type ProviderOAuthAuthorizations,
} from '@samvardiq/platform-credentials';

import {
  GbpConflictError,
  GbpInvalidRequestError,
  GbpLocationNotAvailableError,
  GbpRedirectUriNotAllowedError,
  GoogleAccountMismatchError,
  GoogleAccountUnidentifiedError,
  GoogleAuthorizationDeniedError,
  GoogleResponseInvalidError,
} from './errors.js';
import { GBP_CREDENTIAL_TYPE, GBP_PROVIDER, type GbpLocation, type GbpReadClient, type GoogleOAuthClient } from './google.js';
import { withOrganizationContext, type Database } from './postgres/client.js';
import { gbpLocationBindings as bindings, gbpLocationCandidates as candidates } from './postgres/schema.js';

export interface GbpConnectionSummary {
  connectionId: string;
  status: ExternalProviderConnection['status'];
  googleAccountId: string | null;
  grantedScopes: string[];
  connectedAt: string;
  updatedAt: string;
}

export interface GbpBindingSummary {
  locationName: string;
  accountName: string;
  title: string;
  boundByIdentityId: string;
  boundAt: string;
}

export interface GbpCandidateSummary {
  locationName: string;
  accountName: string;
  accountDisplayName: string;
  title: string;
  addressSummary: string | null;
}

/** Everything an OWNER sees: non-secret metadata only — never a token, code, state or raw provider response. */
export interface GbpStatus {
  connection: GbpConnectionSummary | null;
  binding: GbpBindingSummary | null;
  candidates: GbpCandidateSummary[];
}

export interface GbpDisconnectResult extends GbpStatus {
  /** G1: Samvardiq deleted its own credential; it did NOT revoke the grant at Google. Never claimed otherwise. */
  googleAuthorization: 'NOT_REVOKED';
}

export interface GbpConnectionServiceDependencies {
  db: Database;
  credentials: ProviderCredentialService;
  authorizations: ProviderOAuthAuthorizations;
  oauth: GoogleOAuthClient;
  gbp: GbpReadClient;
  /** Exact-match allow-list (GBP_OAUTH_REDIRECT_URIS). */
  redirectUris: readonly string[];
}

type Tx = Parameters<Parameters<typeof withOrganizationContext>[2]>[0];

/**
 * GBP-W1 — the Google Business Profile connection, under Founder decisions G1–G4.
 *
 * Authority: every OWNER operation requires a HUMAN OWNER TrustedOrganizationContext
 * (resolved fresh by the request boundary on every call). Google OAuth only
 * proves access to Google resources; it never creates or elevates Samvardiq
 * authority, and nothing here derives an organization from Google data.
 *
 * G1: discovery happens only inside the authenticated completion request, with
 * the freshly exchanged access token held in memory. The refresh token goes
 * straight into the ARCH-020 store; no human can ever read it back. Refreshing
 * the candidate list in W1 means reconnecting.
 */
export class GbpConnectionService {
  constructor(private readonly deps: GbpConnectionServiceDependencies) {}

  async status(actor: TrustedOrganizationContext): Promise<GbpStatus> {
    assertOwner(actor);
    const connection = await this.deps.credentials.findOpenConnection(actor, GBP_PROVIDER);
    return this.#status(actor, connection);
  }

  /** Step 1 (OWNER): a single-use, 10-minute authorization bound to this human and organization, and Google's consent URL. */
  async beginAuthorization(actor: TrustedOrganizationContext, redirectUri: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
    assertOwner(actor);
    if (!this.deps.redirectUris.includes(redirectUri)) throw new GbpRedirectUriNotAllowedError();
    const start = await this.deps.authorizations.begin(actor, { provider: GBP_PROVIDER, purpose: 'connect', redirectUri });
    return { authorizationUrl: this.deps.oauth.authorizationUrl({ state: start.state, codeChallenge: start.codeChallenge, redirectUri }), expiresAt: start.expiresAt };
  }

  /**
   * Step 2 (OWNER, same human + organization as step 1 — G4): consume the state
   * FIRST (so a denial, failure or replay always burns it), exchange the code
   * with PKCE, discover accounts/locations with the in-memory access token,
   * store the refresh token through ARCH-020, then replace the candidates.
   */
  async completeAuthorization(actor: TrustedOrganizationContext, input: { state: string; code?: string; error?: string }): Promise<GbpStatus> {
    assertOwner(actor);
    if ((input.code === undefined) === (input.error === undefined)) throw new GbpInvalidRequestError();
    const authorization = await this.deps.authorizations.consume(actor, { provider: GBP_PROVIDER, purpose: 'connect', state: input.state });
    if (input.error !== undefined) throw new GoogleAuthorizationDeniedError();

    const tokens = await this.deps.oauth.exchangeCode({ code: input.code!, redirectUri: authorization.redirectUri, codeVerifier: authorization.codeVerifier });
    const accounts = await this.deps.gbp.listAccounts(tokens.accessToken);
    // The user's own PERSONAL account identifies the Google account for G3's same-account rule (Google lists it first).
    const googleAccount = accounts.find((a) => a.type === 'PERSONAL');
    if (!googleAccount) throw new GoogleAccountUnidentifiedError();
    const discovered = new Map<string, GbpLocation>();
    for (const account of accounts) {
      for (const location of await this.deps.gbp.listLocations(tokens.accessToken, account)) if (!discovered.has(location.locationName)) discovered.set(location.locationName, location);
    }

    const secret = Buffer.from(JSON.stringify({ refresh_token: tokens.refreshToken }), 'utf8');
    let connection: ExternalProviderConnection;
    try {
      const open = await this.deps.credentials.findOpenConnection(actor, GBP_PROVIDER);
      const credential = { credentialType: GBP_CREDENTIAL_TYPE, secret, grantedScopes: tokens.grantedScopes, externalAccountId: googleAccount.accountName };
      if (open && open.externalAccountId !== googleAccount.accountName) throw new GoogleAccountMismatchError();
      connection = open ? await this.deps.credentials.reauthorize(actor, open.connectionId, credential) : await this.deps.credentials.connect(actor, { provider: GBP_PROVIDER, ...credential });
    } catch (error) {
      // A concurrent completion created the organization's one open connection first (G3 unique index).
      if (error instanceof CredentialStoreError && error.sqlState === '23505') throw new GbpConflictError('already_connected');
      throw error;
    } finally {
      secret.fill(0);
    }

    await this.#tx(actor, async (tx) => {
      await tx.delete(candidates).where(and(eq(candidates.organizationId, actor.organizationId), eq(candidates.connectionId, connection.connectionId)));
      if (discovered.size) {
        await tx.insert(candidates).values(
          [...discovered.values()].map((l) => ({ organizationId: actor.organizationId, connectionId: connection.connectionId, provider: GBP_PROVIDER, ...l })),
        );
      }
      // A bound location this Google account no longer returns is no longer authorized: unbind it.
      await tx
        .update(bindings)
        .set({ unboundAt: new Date(), unboundByIdentityId: actor.identityId, unbindReason: 'LOCATION_NOT_RETURNED' })
        .where(
          and(
            eq(bindings.organizationId, actor.organizationId),
            eq(bindings.connectionId, connection.connectionId),
            isNull(bindings.unboundAt),
            sql`${bindings.locationName} <> all(${sql.param([...discovered.keys()])}::text[])`,
          ),
        );
    });
    return this.#status(actor, connection);
  }

  /**
   * Explicit binding (OWNER). Only a location discovered for THIS organization's
   * current, ACTIVE connection can be bound (AB/AC); names, addresses and other
   * metadata are never matched. The connection row is share-locked for the
   * transaction, so a concurrent disconnect cannot interleave (AO).
   */
  async bind(actor: TrustedOrganizationContext, locationName: string): Promise<GbpStatus> {
    assertOwner(actor);
    if (typeof locationName !== 'string' || !/^locations\/[A-Za-z0-9_-]{1,64}$/.test(locationName)) throw new GbpInvalidRequestError();
    try {
      await this.#tx(actor, async (tx) => {
        const open = await lockOpenConnection(tx, actor.organizationId);
        if (!open || open.status !== 'ACTIVE') throw new GbpConflictError('not_connected');
        const [candidate] = await tx
          .select()
          .from(candidates)
          .where(and(eq(candidates.organizationId, actor.organizationId), eq(candidates.connectionId, open.connectionId), eq(candidates.locationName, locationName)));
        if (!candidate) throw new GbpLocationNotAvailableError();
        await tx.insert(bindings).values({
          organizationId: actor.organizationId,
          bindingId: randomUUID(),
          connectionId: open.connectionId,
          provider: GBP_PROVIDER,
          locationName,
          accountName: candidate.accountName,
          title: candidate.title,
          boundByIdentityId: actor.identityId,
        });
      });
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint === 'gbp_location_bindings_active_organization_key') throw new GbpConflictError('already_bound');
      if (constraint === 'gbp_location_bindings_active_location_key') throw new GbpConflictError('bound_elsewhere');
      throw error;
    }
    return this.status(actor);
  }

  /** OWNER: end the active binding (history kept). Idempotent. */
  async unbind(actor: TrustedOrganizationContext): Promise<GbpStatus> {
    assertOwner(actor);
    await this.#tx(actor, (tx) =>
      tx
        .update(bindings)
        .set({ unboundAt: new Date(), unboundByIdentityId: actor.identityId, unbindReason: 'OWNER_UNBOUND' })
        .where(and(eq(bindings.organizationId, actor.organizationId), isNull(bindings.unboundAt))),
    );
    return this.status(actor);
  }

  /**
   * OWNER: LOCAL disconnect (G1/G3). ARCH-020 marks the connection DISCONNECTED
   * and deletes its ciphertext; then every binding of a disconnected
   * connection is ended (history kept) and its candidates removed. Idempotent
   * and convergent: re-running after a partial failure finishes the cleanup.
   * Google-side authorization is NOT revoked — the OWNER removes it in their
   * Google account if desired.
   */
  async disconnect(actor: TrustedOrganizationContext): Promise<GbpDisconnectResult> {
    assertOwner(actor);
    const open = await this.deps.credentials.findOpenConnection(actor, GBP_PROVIDER);
    if (open) await this.deps.credentials.disconnect(actor, open.connectionId);
    await this.#tx(actor, async (tx) => {
      const disconnected = sql`(select c.connection_id from external_provider_connections c
        where c.organization_id = ${actor.organizationId} and c.provider = ${GBP_PROVIDER} and c.status = 'DISCONNECTED')`;
      await tx
        .update(bindings)
        .set({ unboundAt: new Date(), unboundByIdentityId: actor.identityId, unbindReason: 'CONNECTION_DISCONNECTED' })
        .where(and(eq(bindings.organizationId, actor.organizationId), isNull(bindings.unboundAt), sql`${bindings.connectionId} in ${disconnected}`));
      await tx.delete(candidates).where(and(eq(candidates.organizationId, actor.organizationId), sql`${candidates.connectionId} in ${disconnected}`));
    });
    return { ...(await this.status(actor)), googleAuthorization: 'NOT_REVOKED' };
  }

  /**
   * SERVICE PRINCIPAL (the W2 sync foundation; no W1 route calls it): refresh an
   * access token server-side inside ARCH-020's useCredential and verify Google
   * still accepts it with a read-only call. A revoked/expired grant moves the
   * connection to NEEDS_REAUTH; nothing is returned but a count.
   */
  async validateConnection(serviceActor: TrustedOrganizationContext, connectionId: string): Promise<{ accounts: number }> {
    return this.deps.credentials.useCredential(serviceActor, connectionId, GBP_CREDENTIAL_TYPE, async (secret) => {
      const accessToken = await this.deps.oauth.refreshAccessToken(refreshTokenOf(secret));
      return { accounts: (await this.deps.gbp.listAccounts(accessToken)).length };
    });
  }

  async #status(actor: TrustedOrganizationContext, connection: ExternalProviderConnection | null): Promise<GbpStatus> {
    return this.#tx(actor, async (tx) => {
      const [binding] = await tx.select().from(bindings).where(and(eq(bindings.organizationId, actor.organizationId), isNull(bindings.unboundAt)));
      const listed = connection
        ? await tx
            .select()
            .from(candidates)
            .where(and(eq(candidates.organizationId, actor.organizationId), eq(candidates.connectionId, connection.connectionId)))
            .orderBy(candidates.accountName, candidates.title, candidates.locationName)
        : [];
      return {
        connection: connection && {
          connectionId: connection.connectionId,
          status: connection.status,
          googleAccountId: connection.externalAccountId,
          grantedScopes: connection.grantedScopes,
          connectedAt: connection.connectedAt,
          updatedAt: connection.updatedAt,
        },
        binding: binding
          ? { locationName: binding.locationName, accountName: binding.accountName, title: binding.title, boundByIdentityId: binding.boundByIdentityId, boundAt: binding.boundAt.toISOString() }
          : null,
        candidates: listed.map((c) => ({ locationName: c.locationName, accountName: c.accountName, accountDisplayName: c.accountDisplayName, title: c.title, addressSummary: c.addressSummary })),
      };
    });
  }

  #tx<T>(actor: TrustedOrganizationContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withOrganizationContext(this.deps.db, actor.organizationId, work);
  }
}

function assertOwner(actor: TrustedOrganizationContext): void {
  if (!canAdministerProviderConnections(actor)) throw new CredentialAccessDeniedError();
}

/** The organization's open GBP connection, share-locked until the transaction ends (blocks a concurrent ARCH-020 disconnect, which locks FOR UPDATE). */
async function lockOpenConnection(tx: Tx, organizationId: string): Promise<{ connectionId: string; status: string } | undefined> {
  const result = await tx.execute(sql`select connection_id, status from external_provider_connections
    where organization_id = ${organizationId} and provider = ${GBP_PROVIDER} and status <> 'DISCONNECTED' for share`);
  const row = result.rows[0] as { connection_id: string; status: string } | undefined;
  return row && { connectionId: row.connection_id, status: row.status };
}

function uniqueViolation(error: unknown): string | undefined {
  for (let e = error, depth = 0; typeof e === 'object' && e !== null && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
    if ((e as { code?: unknown }).code === '23505') return (e as { constraint?: string }).constraint;
  }
  return undefined;
}

function refreshTokenOf(secret: Buffer): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret.toString('utf8'));
  } catch {
    throw new GoogleResponseInvalidError();
  }
  const token = (parsed as { refresh_token?: unknown })?.refresh_token;
  if (typeof token !== 'string' || !token) throw new GoogleResponseInvalidError();
  return token;
}
