/**
 * IDENTITY-SUPABASE-AUTH-STAGING / Founder decision D5 — the behaviour suite
 * must coexist with legitimate, persistent staging data. This module is the
 * whole safety boundary for that:
 *
 * - every row the suite creates carries a fresh run prefix `w1b-<8 hex>-` in the
 *   column named by SYNTHETIC_PROBES (exact prefix comparison, never LIKE);
 * - `fingerprint` hashes every row OUTSIDE the run, so the suite can prove that
 *   legitimate (and earlier-run) rows are byte-identical afterwards;
 * - `cleanupRun` deletes ONLY current-run rows, one row at a time, re-checking
 *   the run prefix inside every DELETE. A row whose deletion is refused by an
 *   immutability trigger (P0001) or by a reference from a retained row (23503)
 *   is kept and reported — never forced. Any other error aborts and rolls back
 *   the whole cleanup (fail closed). There is no TRUNCATE.
 * - a session advisory lock stops two verifier runs from overlapping.
 */
import { randomBytes } from 'node:crypto';

import type { AdminPostgres } from './stagingDb.js';

/** The column (expression) that carries the synthetic namespace in each table. */
export const SYNTHETIC_PROBES: Readonly<Record<string, string>> = {
  organizations: 'organization_id', goals: 'organization_id', recommendations: 'organization_id', approval_requests: 'organization_id', approval_records: 'organization_id',
  organization_memberships: 'organization_id', identity_audit_events: 'coalesce(organization_id, target_id)', clinic_cms_connections: 'organization_id',
  clinic_cms_connector_evidence: 'organization_id', conversations: 'organization_id', conversation_handoffs: 'organization_id', communication_messages: 'organization_id',
  communication_message_content: 'organization_id', communication_channels: 'organization_id', identities: 'identity_id', identity_provider_links: 'identity_id',
  webhook_event_dedup: 'external_event_id', external_provider_connections: 'organization_id', external_provider_credentials: 'organization_id',
  external_provider_credential_events: 'organization_id', platform_jobs: 'coalesce(organization_id, idempotency_key)',
  provider_oauth_authorizations: 'organization_id', gbp_location_candidates: 'organization_id', gbp_location_bindings: 'organization_id',
};

/**
 * Tables whose non-run rows may legitimately change WHILE the suite runs (not by
 * the suite): `platform_jobs` is written by the live worker/scheduler. The suite
 * still never touches them — its queue check claims only its own run's job type.
 */
export const CONCURRENTLY_WRITTEN = new Set(['platform_jobs']);

const RUN_PREFIX = /^w1b-[0-9a-f]{8}-$/;

export function newRunPrefix(): string {
  return `w1b-${randomBytes(4).toString('hex')}-`;
}

export function assertRunPrefix(prefix: string): void {
  if (!RUN_PREFIX.test(prefix)) throw new Error('refusing to act on a synthetic namespace that is not exactly one run prefix (w1b-<8 hex>-)');
}

/** SQL predicate: the row belongs to the run whose prefix is bound as $1. */
export const inRun = (table: string) => `left(coalesce((${SYNTHETIC_PROBES[table]})::text, ''), char_length($1::text)) = $1::text`;

const known = (table: string) => {
  if (!Object.hasOwn(SYNTHETIC_PROBES, table)) throw new Error(`no synthetic probe for table ${table}`);
};

export async function countRunRows(admin: AdminPostgres, table: string, prefix: string): Promise<number> {
  assertRunPrefix(prefix);
  known(table);
  return Number((await admin.pool.query(`select count(*)::int as n from public.${table} where ${inRun(table)}`, [prefix])).rows[0].n);
}

/** Row count + content hash of every row NOT belonging to the run, per table. */
export async function fingerprint(admin: AdminPostgres, tables: readonly string[], prefix: string): Promise<Record<string, string>> {
  assertRunPrefix(prefix);
  const out: Record<string, string> = {};
  for (const table of tables) {
    known(table);
    if (CONCURRENTLY_WRITTEN.has(table)) continue;
    const r = await admin.pool.query(
      `select count(*)::int as n, coalesce(md5(string_agg(md5(t::text), '' order by md5(t::text))), '-') as h from public.${table} t where not (${inRun(table)})`,
      [prefix],
    );
    out[table] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

export interface CleanupResult {
  deleted: number;
  /** Run rows kept because deletion was refused by an immutability trigger, per table. */
  immutable: Record<string, number>;
  /** Run rows kept because a retained row still references them, per table. */
  referenced: Record<string, number>;
}

export async function cleanupRun(admin: AdminPostgres, tables: readonly string[], prefix: string): Promise<CleanupResult> {
  assertRunPrefix(prefix);
  for (const t of tables) known(t);
  const client = await admin.pool.connect();
  const result: CleanupResult = { deleted: 0, immutable: {}, referenced: {} };
  try {
    await client.query('BEGIN');
    const pending = new Map<string, string[]>(); // table -> ctids of current-run rows
    for (const table of tables) {
      const rows = (await client.query(`select ctid::text as id from public.${table} where ${inRun(table)}`, [prefix])).rows as { id: string }[];
      if (rows.length) pending.set(table, rows.map((r) => r.id));
    }
    const immutable = new Map<string, Set<string>>();
    for (let progress = true; progress; ) {
      progress = false;
      for (const [table, ids] of pending) {
        const keep: string[] = [];
        for (const id of ids) {
          if (immutable.get(table)?.has(id)) {
            keep.push(id);
            continue;
          }
          await client.query('SAVEPOINT row_delete');
          try {
            // The run prefix is re-checked in the DELETE itself: a stale or foreign ctid deletes nothing.
            const r = await client.query(`delete from public.${table} where ctid = $2::tid and ${inRun(table)}`, [prefix, id]);
            await client.query('RELEASE SAVEPOINT row_delete');
            result.deleted += r.rowCount ?? 0;
            if (r.rowCount) progress = true;
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT row_delete');
            const code = (error as { code?: string }).code;
            if (code === 'P0001') {
              if (!immutable.has(table)) immutable.set(table, new Set());
              immutable.get(table)!.add(id);
              keep.push(id);
            } else if (code === '23503') {
              keep.push(id); // still referenced; retried after its referencing rows are gone
            } else {
              throw error;
            }
          }
        }
        if (keep.length) pending.set(table, keep);
        else pending.delete(table);
      }
    }
    for (const [table, ids] of pending) {
      const imm = ids.filter((id) => immutable.get(table)?.has(id)).length;
      if (imm) result.immutable[table] = imm;
      if (ids.length - imm) result.referenced[table] = ids.length - imm;
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Session advisory lock for the whole run; fails closed if another verifier run holds it. */
export async function acquireVerifierLock(admin: AdminPostgres): Promise<() => Promise<void>> {
  const client = await admin.pool.connect();
  const got = (await client.query(`select pg_try_advisory_lock(hashtext('samvardiq.behaviour-verifier')) as ok`)).rows[0].ok;
  if (got !== true) {
    client.release();
    throw new Error('another behaviour-verifier run holds the verifier lock — refusing to run concurrently');
  }
  return async () => {
    try {
      await client.query(`select pg_advisory_unlock(hashtext('samvardiq.behaviour-verifier'))`);
    } finally {
      client.release();
    }
  };
}
