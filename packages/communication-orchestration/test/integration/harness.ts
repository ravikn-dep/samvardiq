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
  owner: PostgresClient;
  app: PostgresClient;
  truncateAll(): Promise<void>;
  stop(): Promise<void>;
}

/** Same pattern as every other package's own test/integration/harness.ts. */
export async function startHarness(port: number): Promise<Harness> {
  const dataDir = path.join(os.tmpdir(), `samvardiq-comms-pg-test-${port}-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('samvardiq_comms_test');

  const owner = createPostgresClient({ connectionString: `postgres://postgres:postgres@localhost:${port}/samvardiq_comms_test` });
  await runMigrations(owner.db, MIGRATIONS_FOLDER);

  const appPassword = crypto.randomBytes(24).toString('hex');
  await owner.pool.query(`ALTER ROLE samvardiq_app PASSWORD '${appPassword}'`);

  const app = createPostgresClient({ connectionString: `postgres://samvardiq_app:${appPassword}@localhost:${port}/samvardiq_comms_test` });

  async function truncateAll(): Promise<void> {
    await owner.pool.query('TRUNCATE communication_message_content, communication_messages, conversations, webhook_event_dedup, communication_channels RESTART IDENTITY CASCADE');
  }

  async function stop(): Promise<void> {
    await app.close();
    await owner.close();
    await stopEmbeddedPostgres(pg, dataDir);
  }

  return { owner, app, truncateAll, stop };
}
