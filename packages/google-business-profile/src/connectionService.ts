import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import type { AuthorizationService, TrustedOrganizationContext } from '@samvardiq/identity-access';
import {
  canAdministerProviderConnections,
  CredentialAccessDeniedError,
  CredentialStoreError,
  CredentialUnavailableError,
  type CredentialInUse,
  type ExternalProviderConnection,
  type ProviderCredentialService,
  type ProviderOAuthAuthorizations,
} from '@samvardiq/platform-credentials';

import {
  failureClassOf,
  GbpConflictError,
  GbpInvalidRequestError,
  GbpLocationNotAvailableError,
  GbpRedirectUriNotAllowedError,
  GbpRevocationFailedError,
  GbpServicePrincipalUnavailableError,
  GoogleAccountMismatchError,
  GoogleAccountUnidentifiedError,
  GoogleAuthorizationDeniedError,
  GoogleResponseInvalidError,
} from './errors.js';
import { GBP_CREDENTIAL_TYPE, GBP_PROVIDER, type GbpAccount, type GbpLocation, type GbpReadClient, type GoogleOAuthClient } from './google.js';
import { withOrganizationContext, type Database } from './postgres/client.js';
import { gbpLocationBindings as bindings, gbpLocationCandidates as candidates, gbpOperationEvents as operationEvents } from './postgres/schema.js';

/**
 * G1: the identity-provider name of an organization's Google Business Profile
 * service principal. Provisioned once per organization by an operator
 * (apps/api/scripts/provisionGbpServicePrincipal.ts, ADR-IDENTITY-002) — a
 * `principalType: 'service'` identity linked as (this provider, organization ID)
 * with an ACTIVE MEMBER membership in that organization only. Suspending or
 * revoking that membership is the kill switch.
 */
export const GBP_SERVICE_PRINCIPAL_PROVIDER = 'samvardiq-gbp-connector';

/** Resolves the organization's GBP service principal through the unmodified `resolveTrustedContext` (fresh identity + membership checks). */
export type GbpServicePrincipalResolver = (organizationId: string) => Promise<TrustedOrganizationContext>;

export function gbpServicePrincipalResolver(authz: Pick<AuthorizationService, 'resolveTrustedContext'>): GbpServicePrincipalResolver {
  return (organizationId) =>
    authz.resolveTrustedContext({
      principal: { provider: GBP_SERVICE_PRINCIPAL_PROVIDER, providerSubject: organizationId, verifiedAt: new Date().toISOString() },
      requestedOrganizationId: organizationId,
    });
}

/** The only provider operations a service principal executes for an OWNER request (G1). Nothing else can reach a stored credential. */
export type GbpOperation = 'GBP_DISCOVER_LOCATIONS' | 'GBP_VERIFY_CONNECTION' | 'GBP_REVOKE_CONNECTION';

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
  /** Set while Google no longer returns this location to the connection (or a re-authorization awaits revalidation): not usable. */
  accessLostAt: string | null;
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
  bindings: GbpBindingSummary[];
  candidates: GbpCandidateSummary[];
}

/**
 * Google-side revocation outcome of a disconnect. REVOKED only on Google's
 * documented success; FAILED for any other answer; NOT_ATTEMPTED when no usable
 * credential or service principal existed; NOT_REQUESTED when the OWNER chose a
 * local-only disconnect. The local disconnect happens in every case.
 */
export type GoogleRevocationOutcome = 'REVOKED' | 'FAILED' | 'NOT_ATTEMPTED' | 'NOT_REQUESTED';

export interface GbpDisconnectResult extends GbpStatus {
  googleRevocation: GoogleRevocationOutcome;
}

export interface GbpVerifyResult extends GbpStatus {
  health: 'HEALTHY';
  checkedAt: string;
}

export interface GbpConnectionServiceDependencies {
  db: Database;
  credentials: ProviderCredentialService;
  authorizations: ProviderOAuthAuthorizations;
  oauth: GoogleOAuthClient;
  gbp: GbpReadClient;
  servicePrincipal: GbpServicePrincipalResolver;
  /** Exact-match allow-list (GBP_OAUTH_REDIRECT_URIS). */
  redirectUris: readonly string[];
}

/** What a service operation sees of the stored credential: the refresh token, and a lazily refreshed access token. Server memory only. */
interface CredentialSession {
  refreshToken: string;
  accessToken(): Promise<string>;
}

type Tx = Parameters<Parameters<typeof withOrganizationContext>[2]>[0];

const LOCATION_NAME = /^locations\/[A-Za-z0-9_-]{1,64}$/;
const MAX_BIND = 25;

/**
 * GBP-W1 — the Google Business Profile connection, under Founder decisions
 * G1–G4 (2026-10-10, ARCH-022).
 *
 * Authority: every public method requires a HUMAN OWNER TrustedOrganizationContext
 * (resolved fresh by the request boundary on every call). Google OAuth only
 * proves access to Google resources; it never creates or elevates Samvardiq
 * authority, and nothing here derives an organization from Google data or a
 * request body — only from the OWNER's context.
 *
 * G1: an OWNER never receives plaintext. Stored-credential use happens only in
 * `#execute`: the OWNER's request is audited, the organization's own GBP
 * service principal is resolved fresh (for the OWNER's organization only — no
 * impersonation, no other organization), and ARCH-020 `useCredential` runs one
 * allow-listed operation. The service outcome is audited separately.
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
    // Refuse before consent if the organization could never use the credential it is about to grant.
    await this.#servicePrincipal(actor);
    const start = await this.deps.authorizations.begin(actor, { provider: GBP_PROVIDER, purpose: 'connect', redirectUri });
    return { authorizationUrl: this.deps.oauth.authorizationUrl({ state: start.state, codeChallenge: start.codeChallenge, redirectUri }), expiresAt: start.expiresAt };
  }

  /**
   * Step 2 (OWNER, same human + organization as step 1 — G4): consume the state
   * FIRST (so a denial, failure or replay always burns it), exchange the code
   * with PKCE, identify the Google account with the in-memory access token,
   * store the refresh token through ARCH-020, then run the first discovery as a
   * service operation on the STORED credential.
   *
   * Recovery: the token exchange is an external side effect outside any
   * transaction. If anything after it fails, nothing partial is stored (connect
   * is one transaction) and the tokens are dropped from memory; the OWNER
   * starts again (prompt=consent issues a fresh grant). Samvardiq does not
   * auto-revoke the dropped grant: Google revocation is grant-wide and would
   * also break any other organization connected with the same Google user.
   */
  async completeAuthorization(actor: TrustedOrganizationContext, input: { state: string; code?: string; error?: string }): Promise<GbpStatus> {
    assertOwner(actor);
    if ((input.code === undefined) === (input.error === undefined)) throw new GbpInvalidRequestError();
    // Kill switch engaged since step 1: refuse before the code is exchanged, so no unusable credential is ever stored.
    await this.#servicePrincipal(actor);
    const authorization = await this.deps.authorizations.consume(actor, { provider: GBP_PROVIDER, purpose: 'connect', state: input.state });
    if (input.error !== undefined) throw new GoogleAuthorizationDeniedError();

    const tokens = await this.deps.oauth.exchangeCode({ code: input.code!, redirectUri: authorization.redirectUri, codeVerifier: authorization.codeVerifier });
    const googleAccount = personalAccount(await this.deps.gbp.listAccounts(tokens.accessToken));

    const secret = serializeRefreshToken(tokens.refreshToken);
    let connection: ExternalProviderConnection;
    try {
      const open = await this.deps.credentials.findOpenConnection(actor, GBP_PROVIDER);
      if (open && open.externalAccountId !== googleAccount) throw new GoogleAccountMismatchError();
      const credential = { credentialType: GBP_CREDENTIAL_TYPE, secret, grantedScopes: tokens.grantedScopes, externalAccountId: googleAccount };
      if (open) {
        // G3: existing bindings survive a same-account re-authorization only once discovery revalidates them.
        await this.#tx(actor, (tx) => markAccessUnverified(tx, actor.organizationId, open.connectionId));
        connection = await this.deps.credentials.reauthorize(actor, open.connectionId, credential);
      } else {
        connection = await this.deps.credentials.connect(actor, { provider: GBP_PROVIDER, ...credential });
      }
    } catch (error) {
      // A concurrent completion created the organization's one open connection first (G3 unique index).
      if (error instanceof CredentialStoreError && error.sqlState === '23505') throw new GbpConflictError('already_connected');
      throw error;
    } finally {
      secret.fill(0);
    }

    await this.#execute(actor, connection, 'GBP_DISCOVER_LOCATIONS', (session) => this.#discover(actor, connection, session));
    return this.status(actor);
  }

  /** OWNER → service GBP_DISCOVER_LOCATIONS: refresh the candidate list and revalidate every active binding. */
  async refreshDiscovery(actor: TrustedOrganizationContext): Promise<GbpStatus> {
    const connection = await this.#activeConnection(actor);
    await this.#execute(actor, connection, 'GBP_DISCOVER_LOCATIONS', (session) => this.#discover(actor, connection, session));
    return this.status(actor);
  }

  /** OWNER → service GBP_VERIFY_CONNECTION: Google still accepts the stored grant and it still belongs to the connected Google account. */
  async verifyConnection(actor: TrustedOrganizationContext): Promise<GbpVerifyResult> {
    assertOwner(actor);
    const connection = await this.deps.credentials.findOpenConnection(actor, GBP_PROVIDER);
    if (!connection) throw new GbpConflictError('not_connected');
    await this.#execute(actor, connection, 'GBP_VERIFY_CONNECTION', async (session) => {
      if (personalAccount(await this.deps.gbp.listAccounts(await session.accessToken())) !== connection.externalAccountId) throw new GoogleAccountMismatchError();
    });
    return { ...(await this.status(actor)), health: 'HEALTHY', checkedAt: new Date().toISOString() };
  }

  /**
   * Explicit binding (OWNER, `confirm: true` required). Only locations
   * discovered for THIS organization's current, ACTIVE connection can be bound
   * (AB/AC); names, addresses and other metadata are never matched. All or
   * nothing. The connection row is share-locked for the transaction, so a
   * concurrent disconnect cannot interleave (AO). A location bound to another
   * organization is refused by the database (AN/AW).
   */
  async bind(actor: TrustedOrganizationContext, input: { locationNames: string[]; confirm: boolean }): Promise<GbpStatus> {
    assertOwner(actor);
    const names = input?.locationNames;
    if (input?.confirm !== true || !Array.isArray(names) || names.length < 1 || names.length > MAX_BIND || new Set(names).size !== names.length) throw new GbpInvalidRequestError();
    if (!names.every((n) => typeof n === 'string' && LOCATION_NAME.test(n))) throw new GbpInvalidRequestError();
    try {
      await this.#tx(actor, async (tx) => {
        const open = await lockConnection(tx, actor.organizationId);
        if (!open || open.status !== 'ACTIVE') throw new GbpConflictError('not_connected');
        const found = await tx
          .select()
          .from(candidates)
          .where(and(eq(candidates.organizationId, actor.organizationId), eq(candidates.connectionId, open.connectionId), inArray(candidates.locationName, names)));
        if (found.length !== names.length) throw new GbpLocationNotAvailableError();
        const already = await tx
          .select({ locationName: bindings.locationName })
          .from(bindings)
          .where(and(eq(bindings.organizationId, actor.organizationId), isNull(bindings.unboundAt), inArray(bindings.locationName, names)));
        if (already.length) throw new GbpConflictError('already_bound');
        await tx.insert(bindings).values(
          found.map((c) => ({
            organizationId: actor.organizationId,
            bindingId: randomUUID(),
            connectionId: open.connectionId,
            provider: GBP_PROVIDER,
            locationName: c.locationName,
            accountName: c.accountName,
            title: c.title,
            boundByIdentityId: actor.identityId,
          })),
        );
      });
    } catch (error) {
      if (uniqueViolation(error) === 'gbp_location_bindings_active_location_key') throw new GbpConflictError('bound_elsewhere');
      throw error;
    }
    return this.status(actor);
  }

  /** OWNER: end one location's active binding (history kept). Idempotent. */
  async unbind(actor: TrustedOrganizationContext, locationName: string): Promise<GbpStatus> {
    assertOwner(actor);
    if (typeof locationName !== 'string' || !LOCATION_NAME.test(locationName)) throw new GbpInvalidRequestError();
    await this.#tx(actor, (tx) =>
      tx
        .update(bindings)
        .set({ unboundAt: new Date(), unboundByIdentityId: actor.identityId, unbindReason: 'OWNER_UNBOUND' })
        .where(and(eq(bindings.organizationId, actor.organizationId), eq(bindings.locationName, locationName), isNull(bindings.unboundAt))),
    );
    return this.status(actor);
  }

  /**
   * OWNER: disconnect, optionally revoking at Google first.
   *
   * 1. `revokeGoogleAccess`: service GBP_REVOKE_CONNECTION while the credential
   *    still exists (ARCH-020: revoke before local deletion). Google revokes
   *    the user's whole grant to this Google Cloud project — every Samvardiq
   *    organization connected with the same Google user loses access too,
   *    which is why it is the OWNER's explicit choice.
   * 2. Always: ARCH-020 marks the connection DISCONNECTED and deletes its
   *    ciphertext, so no further Samvardiq use is possible whatever Google
   *    answered; then every binding of a disconnected connection is ended
   *    (history kept) and its candidates removed. Idempotent and convergent:
   *    re-running after a partial failure finishes the cleanup.
   */
  async disconnect(actor: TrustedOrganizationContext, input: { revokeGoogleAccess: boolean }): Promise<GbpDisconnectResult> {
    assertOwner(actor);
    if (typeof input?.revokeGoogleAccess !== 'boolean') throw new GbpInvalidRequestError();
    const open = await this.deps.credentials.findOpenConnection(actor, GBP_PROVIDER);

    let googleRevocation: GoogleRevocationOutcome = 'NOT_REQUESTED';
    if (open && input.revokeGoogleAccess) {
      if (open.status !== 'ACTIVE') googleRevocation = 'NOT_ATTEMPTED';
      else {
        try {
          await this.#execute(actor, open, 'GBP_REVOKE_CONNECTION', async (session) => {
            if (!(await this.deps.oauth.revoke(session.refreshToken))) throw new GbpRevocationFailedError();
          });
          googleRevocation = 'REVOKED';
        } catch (error) {
          googleRevocation = error instanceof GbpServicePrincipalUnavailableError || error instanceof CredentialUnavailableError ? 'NOT_ATTEMPTED' : 'FAILED';
        }
      }
    }

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
    return { ...(await this.status(actor)), googleRevocation };
  }

  /**
   * G1 — the single path to a stored credential. Order: audit the OWNER's
   * request (human actor) → resolve the organization's own service principal
   * (fresh; the organization is the OWNER's, never a parameter) → ARCH-020
   * `useCredential` under that principal (re-checks organization, connection
   * ownership and ACTIVE status under RLS) → the allow-listed operation →
   * audit the outcome (service actor, fixed failure class). The refresh token
   * is exchanged for an access token only if the operation needs one, and a
   * rotated refresh token is stored by compare-and-swap (BF/BN).
   */
  async #execute<T>(owner: TrustedOrganizationContext, connection: ExternalProviderConnection, operation: GbpOperation, work: (session: CredentialSession) => Promise<T>): Promise<T> {
    assertOwner(owner);
    const requestId = randomUUID();
    await this.#record(owner, connection.connectionId, operation, requestId, 'REQUESTED');
    const service = await this.#servicePrincipal(owner);
    let result: T;
    try {
      result = await this.deps.credentials.useCredential(service, connection.connectionId, GBP_CREDENTIAL_TYPE, (secret, credential) => {
        const refreshToken = refreshTokenOf(secret);
        let access: Promise<string> | undefined;
        return work({ refreshToken, accessToken: () => (access ??= this.#accessToken(refreshToken, credential)) });
      });
    } catch (error) {
      await this.#record(service, connection.connectionId, operation, requestId, 'FAILED', failureClassOf(error)).catch(() => undefined);
      throw error;
    }
    await this.#record(service, connection.connectionId, operation, requestId, 'SUCCEEDED');
    return result;
  }

  async #accessToken(refreshToken: string, credential: CredentialInUse): Promise<string> {
    const tokens = await this.deps.oauth.refreshAccessToken(refreshToken);
    if (tokens.refreshToken) {
      const successor = serializeRefreshToken(tokens.refreshToken);
      try {
        await credential.replace(successor);
      } finally {
        successor.fill(0);
      }
    }
    return tokens.accessToken;
  }

  /** The OWNER's organization's GBP service principal, or GbpServicePrincipalUnavailableError. Never another organization's, never a human. */
  async #servicePrincipal(owner: TrustedOrganizationContext): Promise<TrustedOrganizationContext> {
    let service: TrustedOrganizationContext;
    try {
      service = await this.deps.servicePrincipal(owner.organizationId);
    } catch {
      throw new GbpServicePrincipalUnavailableError();
    }
    if (service.principalType !== 'service' || service.organizationId !== owner.organizationId) throw new GbpServicePrincipalUnavailableError();
    return service;
  }

  /**
   * Discovery: every account the grant reaches, every location of each
   * (deduplicated), then — in one transaction, only while the connection is
   * still ACTIVE — replace the candidates and revalidate active bindings:
   * returned → usable again; not returned → access lost (fail closed for that
   * location only). Bindings are never deleted or moved by discovery.
   */
  async #discover(actor: TrustedOrganizationContext, connection: ExternalProviderConnection, session: CredentialSession): Promise<void> {
    const accessToken = await session.accessToken();
    const accounts = await this.deps.gbp.listAccounts(accessToken);
    if (personalAccount(accounts) !== connection.externalAccountId) throw new GoogleAccountMismatchError();
    const discovered = new Map<string, GbpLocation>();
    for (const account of accounts) {
      for (const location of await this.deps.gbp.listLocations(accessToken, account)) if (!discovered.has(location.locationName)) discovered.set(location.locationName, location);
    }
    const names = [...discovered.keys()];

    await this.#tx(actor, async (tx) => {
      const locked = await lockConnection(tx, actor.organizationId, connection.connectionId);
      if (!locked || locked.status !== 'ACTIVE') throw new GbpConflictError('not_connected');
      const ofConnection = and(eq(candidates.organizationId, actor.organizationId), eq(candidates.connectionId, connection.connectionId));
      await tx.delete(candidates).where(ofConnection);
      if (names.length) {
        await tx.insert(candidates).values([...discovered.values()].map((l) => ({ organizationId: actor.organizationId, connectionId: connection.connectionId, provider: GBP_PROVIDER, ...l })));
      }
      const active = and(eq(bindings.organizationId, actor.organizationId), eq(bindings.connectionId, connection.connectionId), isNull(bindings.unboundAt));
      await tx
        .update(bindings)
        .set({ accessLostAt: new Date() })
        .where(and(active, isNull(bindings.accessLostAt), names.length ? notInArray(bindings.locationName, names) : undefined));
      if (names.length) await tx.update(bindings).set({ accessLostAt: null }).where(and(active, isNotNull(bindings.accessLostAt), inArray(bindings.locationName, names)));
    });
  }

  async #activeConnection(actor: TrustedOrganizationContext): Promise<ExternalProviderConnection> {
    assertOwner(actor);
    const connection = await this.deps.credentials.findOpenConnection(actor, GBP_PROVIDER);
    if (!connection || connection.status !== 'ACTIVE') throw new GbpConflictError('not_connected');
    return connection;
  }

  async #record(actor: TrustedOrganizationContext, connectionId: string, operation: GbpOperation, requestId: string, phase: 'REQUESTED' | 'SUCCEEDED' | 'FAILED', failureClass?: string): Promise<void> {
    await this.#tx(actor, (tx) =>
      tx.insert(operationEvents).values({
        organizationId: actor.organizationId,
        eventId: randomUUID(),
        requestId,
        connectionId,
        provider: GBP_PROVIDER,
        operation,
        phase,
        actorPrincipalType: actor.principalType,
        actorIdentityId: actor.identityId,
        failureClass: failureClass ?? null,
      }),
    );
  }

  async #status(actor: TrustedOrganizationContext, connection: ExternalProviderConnection | null): Promise<GbpStatus> {
    return this.#tx(actor, async (tx) => {
      const bound = await tx
        .select()
        .from(bindings)
        .where(and(eq(bindings.organizationId, actor.organizationId), isNull(bindings.unboundAt)))
        .orderBy(bindings.title, bindings.locationName);
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
        bindings: bound.map((b) => ({
          locationName: b.locationName,
          accountName: b.accountName,
          title: b.title,
          boundByIdentityId: b.boundByIdentityId,
          boundAt: b.boundAt.toISOString(),
          accessLostAt: b.accessLostAt ? b.accessLostAt.toISOString() : null,
        })),
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

/** The user's own PERSONAL account identifies the Google account for G3's same-account rule (Google lists it first). */
function personalAccount(accounts: GbpAccount[]): string {
  const personal = accounts.find((a) => a.type === 'PERSONAL');
  if (!personal) throw new GoogleAccountUnidentifiedError();
  return personal.accountName;
}

/** Re-authorization pending revalidation: every active binding of the connection is unusable until discovery returns it again. */
async function markAccessUnverified(tx: Tx, organizationId: string, connectionId: string): Promise<void> {
  await tx
    .update(bindings)
    .set({ accessLostAt: new Date() })
    .where(and(eq(bindings.organizationId, organizationId), eq(bindings.connectionId, connectionId), isNull(bindings.unboundAt), isNull(bindings.accessLostAt)));
}

/**
 * The organization's open GBP connection (or exactly `connectionId`), share-locked
 * until the transaction ends — it blocks a concurrent ARCH-020 disconnect, which
 * locks FOR UPDATE, so nothing is written for a connection being disconnected.
 */
async function lockConnection(tx: Tx, organizationId: string, connectionId?: string): Promise<{ connectionId: string; status: string } | undefined> {
  const result = await tx.execute(sql`select connection_id, status from external_provider_connections
    where organization_id = ${organizationId} and provider = ${GBP_PROVIDER}
      and ${connectionId === undefined ? sql`status <> 'DISCONNECTED'` : sql`connection_id = ${connectionId}`} for share`);
  const row = result.rows[0] as { connection_id: string; status: string } | undefined;
  return row && { connectionId: row.connection_id, status: row.status };
}

function uniqueViolation(error: unknown): string | undefined {
  for (let e = error, depth = 0; typeof e === 'object' && e !== null && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
    if ((e as { code?: unknown }).code === '23505') return (e as { constraint?: string }).constraint;
  }
  return undefined;
}

function serializeRefreshToken(refreshToken: string): Buffer {
  return Buffer.from(JSON.stringify({ refresh_token: refreshToken }), 'utf8');
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
