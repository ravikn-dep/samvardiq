import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import EmbeddedPostgres from 'embedded-postgres';

import { createPostgresClient, runMigrations, type PostgresClient } from '../../src/postgres/client.js';

/**
 * embedded-postgres's own Windows `stop()` path kills the process via
 * `taskkill /pid ... /f /t` without awaiting it, then resolves as soon as
 * the ORIGINAL process's `exit` event fires and immediately runs its own
 * `fs.rm(databaseDir, { recursive, force })` with no retry (see
 * node_modules/embedded-postgres/dist/index.js). Windows can report a
 * forcibly-killed process as exited before the OS releases all its file
 * handles, so that immediate `fs.rm` intermittently throws EBUSY/EPERM —
 * an upstream library race, not anything in this harness. By the time it
 * throws, the postgres process is already confirmed dead (the kill step's
 * own promise already resolved) — only the disposable temp directory's
 * removal raced — so retry that removal ourselves with backoff rather than
 * letting a teardown-only race fail the test.
 */
async function stopEmbeddedPostgres(pg: EmbeddedPostgres, dataDir: string): Promise<void> {
  try {
    await pg.stop();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
    await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

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
    await stopEmbeddedPostgres(pg, dataDir);
  }

  return { owner, app, truncateAll, stop };
}
