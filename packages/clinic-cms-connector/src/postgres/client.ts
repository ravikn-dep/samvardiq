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
 * Same mechanism as identity-access's/data-foundation's own
 * `withOrganizationContext` — sets `app.current_org_id` via `set_config`'s
 * parameterized third argument (never string interpolation) for the
 * duration of one transaction. Every caller must supply a server-verified
 * `organizationId` (from `TrustedOrganizationContext`), never a raw
 * client-supplied value.
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
