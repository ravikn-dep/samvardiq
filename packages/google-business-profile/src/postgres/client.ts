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
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

/** A GBP database view over an EXISTING pool (the API shares the credential pool rather than opening a new one — runtime pool budget). */
export function gbpDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}

/** Package-specific journal schema — see any other package's client.ts (INFRA-W1A) for why journals are never shared. */
export async function runMigrations(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder, migrationsSchema: 'drizzle_google_business_profile' });
}

/** Same mechanism as every other package's `withOrganizationContext`. */
export async function withOrganizationContext<T>(db: Database, organizationId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${organizationId}, true)`);
    return fn(tx);
  });
}
