import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import EmbeddedPostgres from 'embedded-postgres';

import { createPostgresClient, runMigrations, type PostgresClient } from '../../src/postgres/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

export interface Harness {
  /** Connects as the migration/owner role (the embedded cluster's bootstrap superuser). Used only for setup/teardown/proving the trigger blocks even privileged roles — never for repository-under-test calls. */
  owner: PostgresClient;
  /** Connects as samvardiq_app — the non-superuser, RLS-subject, grant-restricted role every repository adapter test runs as. */
  app: PostgresClient;
  truncateAll(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts a real, disposable PostgreSQL server (via `embedded-postgres` — a
 * genuine postgres binary spawned as a subprocess, not a substitute engine),
 * runs the full migration chain, and provisions the samvardiq_app role's
 * password. The password is `crypto.randomBytes` hex — provably free of SQL
 * metacharacters by construction, generated fresh per test run, and never
 * written to disk or committed; that's why it's safe to interpolate directly
 * into the ALTER ROLE statement below (ALTER ROLE's PASSWORD clause does not
 * accept a bind parameter in PostgreSQL's grammar, unlike ordinary DML).
 */
export async function startHarness(port: number): Promise<Harness> {
  const dataDir = path.join(os.tmpdir(), `samvardiq-pg-test-${port}-${Date.now()}`);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('samvardiq_test');

  const owner = createPostgresClient({
    connectionString: `postgres://postgres:postgres@localhost:${port}/samvardiq_test`,
  });

  await runMigrations(owner.db, MIGRATIONS_FOLDER);

  const appPassword = crypto.randomBytes(24).toString('hex'); // [0-9a-f] only — cannot contain SQL metacharacters
  await owner.pool.query(`ALTER ROLE samvardiq_app PASSWORD '${appPassword}'`);

  const app = createPostgresClient({
    connectionString: `postgres://samvardiq_app:${appPassword}@localhost:${port}/samvardiq_test`,
  });

  async function truncateAll(): Promise<void> {
    await owner.pool.query(
      'TRUNCATE approval_records, approval_requests, recommendations, goals, organizations RESTART IDENTITY CASCADE',
    );
  }

  async function stop(): Promise<void> {
    await app.close();
    await owner.close();
    await pg.stop();
  }

  return { owner, app, truncateAll, stop };
}
