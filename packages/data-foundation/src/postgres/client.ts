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

/** Reads DATABASE_URL (or an explicit config) — never a hardcoded connection string. */
export function createPostgresClient(config: PoolConfig = {}): PostgresClient {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ...config });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export async function runMigrations(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/**
 * Runs `fn` inside one DB transaction with `app.current_org_id` set for the
 * duration of that transaction (set_config's third argument `true` = local,
 * equivalent to SET LOCAL — it resets automatically at transaction end, so
 * a pooled connection can never leak org context into the next request).
 *
 * Every RLS policy in drizzle/0001_rls_and_roles.sql keys off this exact
 * setting. `set_config` is called as a parameterized function (via drizzle's
 * `sql` tagged template, which binds `organizationId` as a query parameter),
 * not by interpolating the value into SQL text — this is deliberately
 * injection-safe.
 *
 * Trust boundary: this sets context from whatever `organizationId` the
 * caller passes in — the same trust boundary the in-memory repositories
 * already had. A future authentication/session layer must resolve
 * `organizationId` from a verified identity before it reaches here; this
 * function does not and should not attempt identity verification itself.
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

/** Postgres error shape for `code` (SQLSTATE) — used to map DB errors to domain errors. */
export interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

/** Unwraps drizzle-orm's DrizzleQueryError (real pg error lives in `.cause`) to read the SQLSTATE code. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error) return (error as PgError).code;
  if ('cause' in error) return pgErrorCode((error as { cause: unknown }).cause);
  return undefined;
}
