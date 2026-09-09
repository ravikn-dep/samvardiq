import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import EmbeddedPostgres from 'embedded-postgres';

import {
  createPostgresClient as createDataFoundationClient,
  runMigrations as runDataFoundationMigrations,
  type PostgresClient as DataFoundationClient,
} from '@samvardiq/data-foundation/dist/postgres/client.js';
import {
  createPostgresClient as createIdentityClient,
  runMigrations as runIdentityMigrations,
  type PostgresClient as IdentityClient,
} from '@samvardiq/identity-access/dist/postgres/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FOUNDATION_MIGRATIONS = path.resolve(__dirname, '../../../data-foundation/drizzle');
const IDENTITY_MIGRATIONS = path.resolve(__dirname, '../../../identity-access/drizzle');

/**
 * Section 21/36: both packages' migrations are designed to run against
 * ONE physical database (identity-access's own
 * `0001_rls_membership_and_role.sql` doc comment says so explicitly —
 * its `samvardiq_app` role creation is idempotent for exactly this
 * reason). This harness is the first place that combination is actually
 * exercised: `organizations`/`goals` (data-foundation) and
 * `identities`/`identity_provider_links`/`organization_memberships`
 * (identity-access) coexist in the same database, connected to through
 * two separately-typed Drizzle clients (each package owns its own
 * schema typing), proving the orphan-organization scenario (AD) and
 * real cross-package RLS enforcement (AC) against a genuine Postgres
 * instance rather than two isolated single-package databases.
 */
export interface Harness {
  dataFoundationOwner: DataFoundationClient;
  dataFoundationApp: DataFoundationClient;
  identityOwner: IdentityClient;
  identityApp: IdentityClient;
  truncateAll(): Promise<void>;
  stop(): Promise<void>;
}

export async function startHarness(port: number): Promise<Harness> {
  const dataDir = path.join(os.tmpdir(), `samvardiq-appsvc-pg-test-${port}-${Date.now()}`);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('samvardiq_appsvc_test');

  const connectionString = `postgres://postgres:postgres@localhost:${port}/samvardiq_appsvc_test`;
  const dataFoundationOwner = createDataFoundationClient({ connectionString });
  const identityOwner = createIdentityClient({ connectionString });

  // Order does not matter (each migration's role creation is idempotent — see doc comment above).
  await runDataFoundationMigrations(dataFoundationOwner.db, DATA_FOUNDATION_MIGRATIONS);
  await runIdentityMigrations(identityOwner.db, IDENTITY_MIGRATIONS);

  const appPassword = crypto.randomBytes(24).toString('hex');
  await dataFoundationOwner.pool.query(`ALTER ROLE samvardiq_app PASSWORD '${appPassword}'`);

  const appConnectionString = `postgres://samvardiq_app:${appPassword}@localhost:${port}/samvardiq_appsvc_test`;
  const dataFoundationApp = createDataFoundationClient({ connectionString: appConnectionString });
  const identityApp = createIdentityClient({ connectionString: appConnectionString });

  async function truncateAll(): Promise<void> {
    await dataFoundationOwner.pool.query(
      'TRUNCATE approval_records, approval_requests, recommendations, goals, organizations, organization_memberships, identity_provider_links, identities RESTART IDENTITY CASCADE',
    );
  }

  async function stop(): Promise<void> {
    await dataFoundationApp.close();
    await identityApp.close();
    await dataFoundationOwner.close();
    await identityOwner.close();
    await pg.stop();
  }

  return { dataFoundationOwner, dataFoundationApp, identityOwner, identityApp, truncateAll, stop };
}
