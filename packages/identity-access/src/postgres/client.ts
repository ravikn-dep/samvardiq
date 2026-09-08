import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface PostgresClient {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

export function createPostgresClient(config: PoolConfig = {}): PostgresClient {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ...config });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export async function runMigrations(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/**
 * Only `organization_memberships` needs this — `identities` and
 * `identity_provider_links` are platform-global and carry no RLS, so
 * plain single-statement queries against `db` are sufficient for them
 * (see identityRepository.ts / providerLinkRepository.ts).
 *
 * Same mechanism as data-foundation's withOrganizationContext: sets
 * `app.current_org_id` via set_config's parameterized third argument
 * (never string interpolation) for the duration of one transaction.
 *
 * Bootstrap-path note (this session's own review requirement): using
 * the *requested* (untrusted) organizationId here to check membership
 * is not a bypass. RLS only restricts *which rows are visible/writable*
 * for that org — it grants no authorization decision by itself. The
 * actual authorization decision is made by application code (
 * AuthorizationService) after inspecting whether a row was found and
 * ACTIVE. This is the identical pattern every other DATA-W3 read
 * already uses; no new privileged role or bypass path was introduced.
 */
export async function withOrganizationContext<T>(
  db: Database,
  organizationId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

export interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error) return (error as PgError).code;
  if ('cause' in error) return pgErrorCode((error as { cause: unknown }).cause);
  return undefined;
}
