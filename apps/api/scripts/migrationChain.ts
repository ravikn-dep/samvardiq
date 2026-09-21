/**
 * INFRA-W1B — the one canonical, ordered list of PostgreSQL-owning packages
 * and how to migrate each. Reuses each package's own
 * `createPostgresClient`/`runMigrations` exactly as every test harness does —
 * no SQL is duplicated here. Shared by the staging runner, the staging
 * verifier's drift audit, and the local Supabase-simulation regression test.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPostgresClient as createDataFoundationClient, runMigrations as migrateDataFoundation } from '@samvardiq/data-foundation/dist/postgres/client.js';
import { createPostgresClient as createIdentityClient, runMigrations as migrateIdentity } from '@samvardiq/identity-access/dist/postgres/client.js';
import { createPostgresClient as createClinicConnectorClient, runMigrations as migrateClinicConnector } from '@samvardiq/clinic-cms-connector/dist/postgres/client.js';
import { createPostgresClient as createCommsClient, runMigrations as migrateComms } from '@samvardiq/communication-orchestration/dist/postgres/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MigrationStep {
  packageName: string;
  migrationsFolder: string;
  createClient: (config: { connectionString: string }) => { db: unknown; close(): Promise<void> };
  runMigrations: (db: never, migrationsFolder: string) => Promise<void>;
}

// Canonical order established and empirically proven by INFRA-W1A. Order is
// no longer *safety*-critical (each package owns an independent
// migrationsSchema — see each client.ts's own INFRA-W1A doc comment), but
// is preserved for operational clarity and because it mirrors the actual
// build/dependency history of this codebase.
export const MIGRATION_STEPS: MigrationStep[] = [
  {
    packageName: 'data-foundation',
    migrationsFolder: path.resolve(__dirname, '../../../packages/data-foundation/drizzle'),
    createClient: createDataFoundationClient as MigrationStep['createClient'],
    runMigrations: migrateDataFoundation as MigrationStep['runMigrations'],
  },
  {
    packageName: 'identity-access',
    migrationsFolder: path.resolve(__dirname, '../../../packages/identity-access/drizzle'),
    createClient: createIdentityClient as MigrationStep['createClient'],
    runMigrations: migrateIdentity as MigrationStep['runMigrations'],
  },
  {
    packageName: 'clinic-cms-connector',
    migrationsFolder: path.resolve(__dirname, '../../../packages/clinic-cms-connector/drizzle'),
    createClient: createClinicConnectorClient as MigrationStep['createClient'],
    runMigrations: migrateClinicConnector as MigrationStep['runMigrations'],
  },
  {
    packageName: 'communication-orchestration',
    migrationsFolder: path.resolve(__dirname, '../../../packages/communication-orchestration/drizzle'),
    createClient: createCommsClient as MigrationStep['createClient'],
    runMigrations: migrateComms as MigrationStep['runMigrations'],
  },
];

/** Thrown when one package's migration fails; carries only the package name and the server-side SQLSTATE/message — never a connection string. */
export class MigrationStepError extends Error {
  constructor(readonly packageName: string, readonly sqlState: string | undefined, message: string) {
    super(message);
  }
}

/** Migrates every package in canonical order. Each package's already-applied migrations are skipped by its own journal, so this is safe to re-run. */
export async function runMigrationChain(connectionString: string, log: (line: string) => void = console.log): Promise<void> {
  const clients: { close(): Promise<void> }[] = [];
  try {
    for (const step of MIGRATION_STEPS) {
      log(`--- ${step.packageName}: migrating ---`);
      const client = step.createClient({ connectionString });
      clients.push(client);
      try {
        await step.runMigrations(client.db as never, step.migrationsFolder);
      } catch (error) {
        const code = (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
        throw new MigrationStepError(step.packageName, code, error instanceof Error ? error.message.split('\n')[0]! : 'migration failed');
      }
      log(`--- ${step.packageName}: done ---`);
    }
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}
