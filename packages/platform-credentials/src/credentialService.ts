import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { TrustedOrganizationContext } from '@samvardiq/identity-access';

import { MAX_SECRET_BYTES, ENVELOPE_ALGORITHM, openCredential, sealCredential, type CredentialBinding } from './envelope.js';
import {
  ConnectionConflictError,
  ConnectionNotFoundError,
  CredentialAccessDeniedError,
  CredentialInvalidError,
  CredentialUnavailableError,
  InvalidCredentialInputError,
  sanitizeStoreErrors,
} from './errors.js';
import type { MasterKeyRing } from './keyRing.js';
import { withOrganizationContext, type Database } from './postgres/client.js';
import { externalProviderConnections as connections, externalProviderCredentialEvents as events, externalProviderCredentials as credentials } from './postgres/schema.js';

export type ConnectionStatus = 'ACTIVE' | 'NEEDS_REAUTH' | 'DISCONNECTED';

/** Non-secret metadata of one stored credential. */
export interface CredentialMetadata {
  credentialId: string;
  credentialType: string;
  keyVersion: number;
  createdAt: string;
  rotatedAt: string | null;
}

/** Non-secret connection metadata — the only shape this module ever returns to an administrator. */
export interface ExternalProviderConnection {
  connectionId: string;
  organizationId: string;
  provider: string;
  externalAccountId: string | null;
  status: ConnectionStatus;
  grantedScopes: string[];
  connectedByIdentityId: string;
  connectedAt: string;
  disconnectedAt: string | null;
  updatedAt: string;
  credentials: CredentialMetadata[];
}

export interface StoreCredentialInput {
  credentialType: string;
  /** Opaque provider material (e.g. a serialized token set). Encrypted before it reaches the database; never retained. */
  secret: Uint8Array;
}

export interface ConnectInput extends StoreCredentialInput {
  provider: string;
  externalAccountId?: string | null;
  grantedScopes: string[];
}

export interface ReauthorizeInput extends StoreCredentialInput {
  externalAccountId?: string | null;
  grantedScopes?: string[];
}

export interface DisconnectResult {
  connection: ExternalProviderConnection;
  /**
   * This generic layer performs LOCAL disconnection only (status + ciphertext
   * deletion). Remote provider revocation belongs to the provider connector,
   * which must revoke (using `useCredential`) BEFORE calling `disconnect`.
   * Always 'NOT_ATTEMPTED' here — never a claim of remote revocation.
   */
  remoteRevocation: 'NOT_ATTEMPTED';
}

/** Managing an organization's external access is managing the organization itself (ADR-PLATFORM-001 §7, same reading as `canAdministerMembership`). */
export function canAdministerProviderConnections(actor: TrustedOrganizationContext): boolean {
  return actor.principalType === 'human' && actor.role === 'OWNER';
}

/** Runtime credential use is for the organization's provisioned service principal only (ADR-IDENTITY-002 / ADR-PLATFORM-002) — never a human session. */
export function canUseProviderCredentials(actor: TrustedOrganizationContext): boolean {
  return actor.principalType === 'service';
}

const IDENTIFIER = /^[a-z][a-z0-9_]{1,62}$/;
const PRINTABLE = /^[\x21-\x7e][\x20-\x7e]*$/;

function assertIdentifier(value: unknown, field: 'provider' | 'credentialType'): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new InvalidCredentialInputError(field);
}

function assertSecret(secret: unknown): asserts secret is Uint8Array {
  if (!(secret instanceof Uint8Array) || secret.length < 1 || secret.length > MAX_SECRET_BYTES) throw new InvalidCredentialInputError('secret');
}

function assertAccountId(value: unknown): asserts value is string | null | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.length > 256 || !PRINTABLE.test(value)) throw new InvalidCredentialInputError('externalAccountId');
}

function assertScopes(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 100 || !value.every((s) => typeof s === 'string' && s.length <= 512 && PRINTABLE.test(s))) {
    throw new InvalidCredentialInputError('grantedScopes');
  }
}

type Tx = Parameters<Parameters<typeof withOrganizationContext>[2]>[0];
type Actor = { principalType: 'human' | 'service'; identityId: string };
type EventType = (typeof events.$inferInsert)['eventType'];

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The credential boundary (ADR-PLATFORM-001 §7–§10). Raw repositories are not
 * exported; there is no list-all, no bulk read and no cross-organization read
 * — every query runs under the caller's own organization context, so RLS
 * (FORCE) scopes it even if a check here were wrong.
 *
 * Plaintext lifetime: a secret is decrypted only inside `useCredential`,
 * handed to the caller's callback as a Buffer, and zero-filled when the
 * callback settles. That is best-effort hygiene, not guaranteed erasure:
 * V8 may have copied it, and any string the callback derives (e.g. an HTTP
 * header) is immutable and lives until garbage-collected.
 */
export class ProviderCredentialService {
  constructor(
    private readonly db: Database,
    private readonly keyRing: MasterKeyRing,
  ) {}

  /** OWNER: create a connection together with its first credential — one transaction, so a connection never exists ACTIVE without one. */
  async connect(actor: TrustedOrganizationContext, input: ConnectInput): Promise<ExternalProviderConnection> {
    this.#assertAdministrator(actor);
    assertIdentifier(input.provider, 'provider');
    assertIdentifier(input.credentialType, 'credentialType');
    assertAccountId(input.externalAccountId);
    assertScopes(input.grantedScopes);
    assertSecret(input.secret);

    const organizationId = actor.organizationId;
    const connectionId = randomUUID();
    const credentialId = randomUUID();
    const envelope = sealCredential(this.keyRing, { organizationId, provider: input.provider, credentialId, credentialType: input.credentialType }, input.secret);

    return this.#tx(organizationId, async (tx) => {
      await tx.insert(connections).values({
        organizationId,
        connectionId,
        provider: input.provider,
        externalAccountId: input.externalAccountId ?? null,
        status: 'ACTIVE',
        grantedScopes: input.grantedScopes,
        connectedByIdentityId: actor.identityId,
      });
      await tx.insert(credentials).values({ organizationId, credentialId, connectionId, provider: input.provider, credentialType: input.credentialType, algorithm: ENVELOPE_ALGORITHM, ...envelope });
      await this.#audit(tx, organizationId, connectionId, actor, 'CONNECTION_CREATED');
      await this.#audit(tx, organizationId, connectionId, actor, 'CREDENTIAL_STORED', credentialId, envelope.keyVersion);
      return this.#read(tx, organizationId, connectionId);
    });
  }

  /**
   * OWNER: attach or replace one credential type (re-authorization). The
   * replacement gets a NEW credential ID — so the old ciphertext can never be
   * replayed into the new row (AAD mismatch) — the old row is deleted in the
   * same transaction, and the connection returns to ACTIVE. Concurrent calls
   * serialize on the connection row lock; the last committed wins and exactly
   * one ciphertext per type remains.
   */
  async reauthorize(actor: TrustedOrganizationContext, connectionId: string, input: ReauthorizeInput): Promise<ExternalProviderConnection> {
    this.#assertAdministrator(actor);
    assertIdentifier(input.credentialType, 'credentialType');
    assertAccountId(input.externalAccountId);
    if (input.grantedScopes !== undefined) assertScopes(input.grantedScopes);
    assertSecret(input.secret);

    const organizationId = actor.organizationId;
    return this.#tx(organizationId, async (tx) => {
      const connection = await this.#lock(tx, organizationId, connectionId);
      if (connection.status === 'DISCONNECTED') throw new ConnectionConflictError();

      const credentialId = randomUUID();
      const binding: CredentialBinding = { organizationId, provider: connection.provider, credentialId, credentialType: input.credentialType };
      const envelope = sealCredential(this.keyRing, binding, input.secret);

      const replaced = await tx
        .delete(credentials)
        .where(and(eq(credentials.organizationId, organizationId), eq(credentials.connectionId, connectionId), eq(credentials.credentialType, input.credentialType)))
        .returning({ credentialId: credentials.credentialId });
      await tx.insert(credentials).values({ ...binding, connectionId, algorithm: ENVELOPE_ALGORITHM, ...envelope });
      await tx
        .update(connections)
        .set({
          status: 'ACTIVE',
          ...(input.externalAccountId !== undefined ? { externalAccountId: input.externalAccountId } : {}),
          ...(input.grantedScopes !== undefined ? { grantedScopes: input.grantedScopes } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(connections.organizationId, organizationId), eq(connections.connectionId, connectionId)));

      for (const old of replaced) await this.#audit(tx, organizationId, connectionId, actor, 'CREDENTIAL_DELETED', old.credentialId);
      await this.#audit(tx, organizationId, connectionId, actor, replaced.length ? 'CREDENTIAL_REPLACED' : 'CREDENTIAL_STORED', credentialId, envelope.keyVersion);
      return this.#read(tx, organizationId, connectionId);
    });
  }

  /** OWNER: LOCAL disconnection — status DISCONNECTED and every ciphertext of the connection deleted, atomically. Idempotent. */
  async disconnect(actor: TrustedOrganizationContext, connectionId: string): Promise<DisconnectResult> {
    this.#assertAdministrator(actor);
    const organizationId = actor.organizationId;
    const connection = await this.#tx(organizationId, async (tx) => {
      const current = await this.#lock(tx, organizationId, connectionId);
      if (current.status !== 'DISCONNECTED') {
        const deleted = await tx.delete(credentials).where(and(eq(credentials.organizationId, organizationId), eq(credentials.connectionId, connectionId))).returning({ credentialId: credentials.credentialId });
        const now = new Date();
        await tx.update(connections).set({ status: 'DISCONNECTED', disconnectedAt: now, updatedAt: now }).where(and(eq(connections.organizationId, organizationId), eq(connections.connectionId, connectionId)));
        for (const old of deleted) await this.#audit(tx, organizationId, connectionId, actor, 'CREDENTIAL_DELETED', old.credentialId);
        await this.#audit(tx, organizationId, connectionId, actor, 'CONNECTION_DISCONNECTED');
      }
      return this.#read(tx, organizationId, connectionId);
    });
    return { connection, remoteRevocation: 'NOT_ATTEMPTED' };
  }

  /** OWNER: non-secret metadata of one connection. */
  async getConnection(actor: TrustedOrganizationContext, connectionId: string): Promise<ExternalProviderConnection> {
    this.#assertAdministrator(actor);
    return this.#tx(actor.organizationId, (tx) => this.#read(tx, actor.organizationId, connectionId));
  }

  /**
   * SERVICE PRINCIPAL: the one runtime capability — "use credential T of
   * connection X under organization Y". Requires, in one consistent
   * snapshot under organization Y's RLS context: the connection exists in Y,
   * is ACTIVE, and holds a credential of type T; then an authenticated
   * envelope under an available key version. The plaintext exists only for
   * the duration of `use`, and is never returned by this method.
   *
   * Tampered/transplanted/corrupt envelope → the connection is moved to
   * NEEDS_REAUTH (audited) and CredentialInvalidError is thrown. A missing or
   * mismatched master key → KeyUnavailableError with no state change (an
   * operator fault must not force every clinic to reconnect).
   */
  async useCredential<T>(actor: TrustedOrganizationContext, connectionId: string, credentialType: string, use: (secret: Buffer) => Promise<T>): Promise<T> {
    if (!canUseProviderCredentials(actor)) throw new CredentialAccessDeniedError();
    assertIdentifier(credentialType, 'credentialType');
    const organizationId = actor.organizationId;

    const row = await this.#tx(organizationId, async (tx) => {
      const [found] = await tx
        .select({ credential: credentials, provider: connections.provider })
        .from(credentials)
        .innerJoin(connections, and(eq(connections.organizationId, credentials.organizationId), eq(connections.connectionId, credentials.connectionId)))
        .where(
          and(
            eq(credentials.organizationId, organizationId),
            eq(credentials.connectionId, connectionId),
            eq(credentials.credentialType, credentialType),
            eq(connections.status, 'ACTIVE'),
          ),
        );
      return found;
    });
    if (!row) throw new CredentialUnavailableError();

    // The binding is what the caller is entitled to (its organization, the connection's provider, the requested type) —
    // so an envelope copied into this row from anywhere else fails authentication.
    const binding: CredentialBinding = { organizationId, provider: row.provider, credentialId: row.credential.credentialId, credentialType };
    let secret: Buffer;
    try {
      secret = openCredential(this.keyRing, binding, row.credential);
    } catch (error) {
      // Best-effort: if recording NEEDS_REAUTH itself fails, the next use fails the same way and retries it.
      if (error instanceof CredentialInvalidError) await this.#markNeedsReauth(actor, connectionId, row.credential.credentialId).catch(() => undefined);
      throw error;
    }
    try {
      return await use(secret);
    } finally {
      secret.fill(0);
    }
  }

  /** Only if the failing credential is still the stored one — a re-authorization that replaced it meanwhile must not be undone. */
  async #markNeedsReauth(actor: TrustedOrganizationContext, connectionId: string, failedCredentialId: string): Promise<void> {
    await this.#tx(actor.organizationId, async (tx) => {
      const connection = await this.#lock(tx, actor.organizationId, connectionId);
      const [stillStored] = await tx
        .select({ credentialId: credentials.credentialId })
        .from(credentials)
        .where(and(eq(credentials.organizationId, actor.organizationId), eq(credentials.credentialId, failedCredentialId)));
      if (connection.status !== 'ACTIVE' || !stillStored) return;
      await tx
        .update(connections)
        .set({ status: 'NEEDS_REAUTH', updatedAt: new Date() })
        .where(and(eq(connections.organizationId, actor.organizationId), eq(connections.connectionId, connectionId)));
      await this.#audit(tx, actor.organizationId, connectionId, actor, 'CONNECTION_NEEDS_REAUTH', failedCredentialId);
    });
  }

  /** Every database step runs under the organization's RLS context and surfaces only sanitized errors. */
  #tx<T>(organizationId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return sanitizeStoreErrors(() => withOrganizationContext(this.db, organizationId, work));
  }

  #assertAdministrator(actor: TrustedOrganizationContext): void {
    if (!canAdministerProviderConnections(actor)) throw new CredentialAccessDeniedError();
  }

  async #lock(tx: Tx, organizationId: string, connectionId: string) {
    const [row] = await tx.select().from(connections).where(and(eq(connections.organizationId, organizationId), eq(connections.connectionId, connectionId))).for('update');
    if (!row) throw new ConnectionNotFoundError();
    return row;
  }

  async #audit(tx: Tx, organizationId: string, connectionId: string, actor: Actor, eventType: EventType, credentialId?: string, keyVersion?: number): Promise<void> {
    await tx.insert(events).values({
      organizationId,
      eventId: randomUUID(),
      connectionId,
      credentialId: credentialId ?? null,
      eventType,
      actorPrincipalType: actor.principalType,
      actorIdentityId: actor.identityId,
      keyVersion: keyVersion ?? null,
    });
  }

  async #read(tx: Tx, organizationId: string, connectionId: string): Promise<ExternalProviderConnection> {
    const [c] = await tx.select().from(connections).where(and(eq(connections.organizationId, organizationId), eq(connections.connectionId, connectionId)));
    if (!c) throw new ConnectionNotFoundError();
    const creds = await tx
      .select({ credentialId: credentials.credentialId, credentialType: credentials.credentialType, keyVersion: credentials.keyVersion, createdAt: credentials.createdAt, rotatedAt: credentials.rotatedAt })
      .from(credentials)
      .where(and(eq(credentials.organizationId, organizationId), eq(credentials.connectionId, connectionId)))
      .orderBy(credentials.credentialType);
    return {
      connectionId: c.connectionId,
      organizationId,
      provider: c.provider,
      externalAccountId: c.externalAccountId,
      status: c.status as ConnectionStatus,
      grantedScopes: c.grantedScopes,
      connectedByIdentityId: c.connectedByIdentityId,
      connectedAt: c.connectedAt.toISOString(),
      disconnectedAt: iso(c.disconnectedAt),
      updatedAt: c.updatedAt.toISOString(),
      credentials: creds.map((k) => ({ ...k, createdAt: k.createdAt.toISOString(), rotatedAt: iso(k.rotatedAt) })),
    };
  }
}
