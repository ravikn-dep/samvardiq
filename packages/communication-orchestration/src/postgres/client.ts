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

/**
 * INFRA-W1A: `migrationsSchema` is package-specific rather than drizzle's
 * shared default (`"drizzle"`) because drizzle's migrator tracks "already
 * applied" via a single global watermark (the latest `created_at` across
 * every row in the journal table), not a per-migration hash set — proven
 * during INFRA-W1A's local preflight that when four packages' migrators
 * share one journal table, running them in the wrong order silently skips
 * an entire package's migrations with no error, because an earlier
 * package's migrations can fall below a later package's watermark. Each
 * package owning its own journal schema makes that failure mode
 * structurally impossible, independent of run order.
 */
export async function runMigrations(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsSchema: 'drizzle_communication_orchestration' });
}

/** Same mechanism as every other package's own `withOrganizationContext` — see identity-access/data-foundation/clinic-cms-connector for the identical pattern and its full rationale. */
export async function withOrganizationContext<T>(db: Database, organizationId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
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
