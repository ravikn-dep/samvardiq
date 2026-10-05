import { randomUUID } from 'node:crypto';

import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { rewrapDataKey } from './envelope.js';
import { KeyVersionInUseError, sanitizeStoreErrors } from './errors.js';
import type { MasterKeyRing } from './keyRing.js';
import { withOrganizationContext, type Database } from './postgres/client.js';
import { externalProviderCredentialEvents as events, externalProviderCredentials as credentials } from './postgres/schema.js';

/**
 * Master-key rotation (ADR-PLATFORM-001 "Key management and rotation"): after
 * the new version is made active, every credential's data key is re-wrapped
 * from its recorded version to the active one. Platform operation — audited
 * as the `system` actor, never exposed to a tenant request.
 *
 * One credential per transaction, conditional on the version it was read at:
 * an interruption at any point leaves every row valid (each names its own
 * version), and re-running simply continues with what is left. Runs under
 * the organization's own RLS context; the operator supplies organization IDs
 * from `keyVersionUsage` (the runtime role cannot enumerate organizations).
 */
export class CredentialKeyRotation {
  constructor(
    private readonly db: Database,
    private readonly keyRing: MasterKeyRing,
  ) {}

  /** Re-wraps one not-yet-rotated credential of the organization. Returns false when none is left. */
  async rewrapNext(organizationId: string): Promise<boolean> {
    const toVersion = this.keyRing.activeVersion;
    return sanitizeStoreErrors(() => withOrganizationContext(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(credentials)
        .where(and(eq(credentials.organizationId, organizationId), ne(credentials.keyVersion, toVersion)))
        .orderBy(asc(credentials.credentialId))
        .limit(1)
        .for('update');
      if (!row) return false;

      const rewrapped = rewrapDataKey(this.keyRing, row, row);
      const updated = await tx
        .update(credentials)
        .set({ ...rewrapped, rotatedAt: new Date() })
        .where(and(eq(credentials.organizationId, organizationId), eq(credentials.credentialId, row.credentialId), eq(credentials.keyVersion, row.keyVersion)))
        .returning({ credentialId: credentials.credentialId });
      if (updated.length !== 1) throw new Error('re-wrap lost its conditional update'); // sanitized to CredentialStoreError; the transaction rolls back
      await tx.insert(events).values({
        organizationId,
        eventId: randomUUID(),
        connectionId: row.connectionId,
        credentialId: row.credentialId,
        eventType: 'CREDENTIAL_REWRAPPED',
        actorPrincipalType: 'system',
        actorIdentityId: null,
        keyVersion: toVersion,
      });
      return true;
    }));
  }

  /** Re-wraps every remaining credential of the organization; returns how many were re-wrapped. Stops at the first failure (fail closed). */
  async rewrapOrganization(organizationId: string): Promise<number> {
    let count = 0;
    while (await this.rewrapNext(organizationId)) count += 1;
    return count;
  }
}

export interface KeyVersionUsage {
  organizationId: string;
  keyVersion: number;
  credentials: number;
}

/**
 * Non-secret inventory: how many credentials each (organization, key version)
 * holds. Must see EVERY organization to be meaningful, so it refuses to run on
 * a connection subject to RLS — an RLS-scoped count of zero would wrongly
 * certify a still-used key as retirable. Run with the administrative
 * (migration) connection, which needs no master key.
 */
export async function keyVersionUsage(db: Database): Promise<KeyVersionUsage[]> {
  const role = await db.execute(sql`select (rolsuper or rolbypassrls) as unrestricted from pg_roles where rolname = current_user`);
  if ((role.rows[0] as { unrestricted?: boolean } | undefined)?.unrestricted !== true) {
    throw new KeyVersionInUseError('usage can only be proven from a connection that sees every organization');
  }
  const rows = await db
    .select({ organizationId: credentials.organizationId, keyVersion: credentials.keyVersion, credentials: sql<number>`count(*)::int` })
    .from(credentials)
    .groupBy(credentials.organizationId, credentials.keyVersion)
    .orderBy(credentials.organizationId, credentials.keyVersion);
  return rows;
}

/** Throws unless `version` wraps no stored credential and is not the active version. Run before removing a version from the key ring. */
export async function assertKeyVersionRetirable(db: Database, version: number, activeVersion: number): Promise<void> {
  if (version === activeVersion) throw new KeyVersionInUseError('it is the active version');
  const inUse = (await keyVersionUsage(db)).filter((u) => u.keyVersion === version).reduce((n, u) => n + u.credentials, 0);
  if (inUse > 0) throw new KeyVersionInUseError(`${inUse} credential(s) still reference it`);
}
