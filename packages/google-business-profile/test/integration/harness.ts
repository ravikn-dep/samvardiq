import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import EmbeddedPostgres from 'embedded-postgres';
import { createPostgresClient as createCredentialsClient, runMigrations as migrateCredentials, type PostgresClient as CredentialsClient } from '@samvardiq/platform-credentials';

import { gbpDatabase, runMigrations, type PostgresClient } from '../../src/index.js';
import { createPostgresClient } from '../../src/postgres/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Same Windows teardown race handling as every other package's harness (see platform-credentials/test/integration/harness.ts). */
async function stopEmbeddedPostgres(pg: EmbeddedPostgres, dataDir: string): Promise<void> {
  try {
    await pg.stop();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
    await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export interface Harness {
  owner: PostgresClient;
  /** The runtime role: the credential service's pool, with the GBP schema as a second view over the SAME pool (as in the API). */
  app: CredentialsClient;
  appGbp: ReturnType<typeof gbpDatabase>;
  url(user: 'owner' | 'app'): string;
  truncateAll(): Promise<void>;
  stop(): Promise<void>;
}

/** Real PostgreSQL with the canonical migration order for these tables: platform-credentials, then google-business-profile. */
export async function startHarness(port: number): Promise<Harness> {
  const dataDir = path.join(os.tmpdir(), `samvardiq-gbp-pg-test-${port}-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('samvardiq_gbp_test');
  const ownerUrl = `postgres://postgres:postgres@localhost:${port}/samvardiq_gbp_test`;

  const credentialsOwner = createCredentialsClient({ connectionString: ownerUrl });
  await migrateCredentials(credentialsOwner.db, path.resolve(__dirname, '../../../platform-credentials/drizzle'));
  await credentialsOwner.close();
  const owner = createPostgresClient({ connectionString: ownerUrl });
  await runMigrations(owner.db, path.resolve(__dirname, '../../drizzle'));

  const appPassword = crypto.randomBytes(24).toString('hex');
  await owner.pool.query(`ALTER ROLE samvardiq_app PASSWORD '${appPassword}'`);
  const appUrl = `postgres://samvardiq_app:${appPassword}@localhost:${port}/samvardiq_gbp_test`;
  const app = createCredentialsClient({ connectionString: appUrl });

  return {
    owner,
    app,
    appGbp: gbpDatabase(app.pool),
    url: (user) => (user === 'owner' ? ownerUrl : appUrl),
    async truncateAll() {
      await owner.pool.query(
        'TRUNCATE gbp_operation_events, gbp_location_bindings, gbp_location_candidates, external_provider_credential_events, external_provider_credentials, external_provider_connections, provider_oauth_authorizations',
      );
    },
    async stop() {
      await app.close();
      await owner.close();
      await stopEmbeddedPostgres(pg, dataDir);
    },
  };
}
