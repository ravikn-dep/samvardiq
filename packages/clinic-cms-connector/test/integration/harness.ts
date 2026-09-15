import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import EmbeddedPostgres from 'embedded-postgres';

import { createPostgresClient, runMigrations, type PostgresClient } from '../../src/postgres/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

export interface Harness {
  owner: PostgresClient;
  app: PostgresClient;
  truncateAll(): Promise<void>;
  stop(): Promise<void>;
}

/** Same pattern as identity-access/data-foundation's own test/integration/harness.ts. */
export async function startHarness(port: number): Promise<Harness> {
  const dataDir = path.join(os.tmpdir(), `samvardiq-clinic-connector-pg-test-${port}-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('samvardiq_clinic_connector_test');

  const owner = createPostgresClient({ connectionString: `postgres://postgres:postgres@localhost:${port}/samvardiq_clinic_connector_test` });
  await runMigrations(owner.db, MIGRATIONS_FOLDER);

  const appPassword = crypto.randomBytes(24).toString('hex');
  await owner.pool.query(`ALTER ROLE samvardiq_app PASSWORD '${appPassword}'`);

  const app = createPostgresClient({ connectionString: `postgres://samvardiq_app:${appPassword}@localhost:${port}/samvardiq_clinic_connector_test` });

  async function truncateAll(): Promise<void> {
    await owner.pool.query('TRUNCATE clinic_cms_connector_evidence, clinic_cms_connections RESTART IDENTITY CASCADE');
  }

  async function stop(): Promise<void> {
    await app.close();
    await owner.close();
    await pg.stop();
  }

  return { owner, app, truncateAll, stop };
}
