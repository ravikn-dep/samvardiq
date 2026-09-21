/**
 * INFRA-W1B — one canonical, deterministic entry point for applying
 * Samvardiq's approved PostgreSQL schema to an empty (or already-migrated,
 * idempotently) Supabase database. This does not deploy any application —
 * it only creates tables/roles/RLS/triggers via each package's own,
 * already-proven migration mechanism, then applies the Supabase-platform
 * hardening documented in `supabaseHardening.ts`. Never seeds patient or
 * clinic data.
 *
 * Run from `apps/api/` (the only place in this repo where all four
 * PostgreSQL-owning packages are already installed dependencies, since
 * this repository has no root workspace):
 *
 *   SAMVARDIQ_DEPLOY_ENV=staging MIGRATION_DATABASE_URL=... npm run migrate:staging
 *
 * Two independent, non-secret confirmations are required before any
 * mutation: `SAMVARDIQ_DEPLOY_ENV` must be exactly `staging`, and
 * `MIGRATION_DATABASE_URL` must be set. Neither value nor any credential
 * derived from it is ever logged — only the non-secret host/port/database
 * name parsed from the connection string are printed, so an operator can
 * visually confirm the target before mutation without the tool ever
 * displaying, and this file never containing, a password or full URI.
 */
import { MIGRATION_STEPS, MigrationStepError, runMigrationChain } from './migrationChain.js';
import { applySupabaseHardening } from './supabaseHardening.js';
import { OperatorError, connectAdmin, describeTarget, requireStagingEnv, sanitizeError } from './stagingDb.js';

async function main(): Promise<void> {
  const connectionString = requireStagingEnv();

  const target = describeTarget(connectionString);
  if (!target.userMatchesStaging) throw new OperatorError('Refusing to run: the connection username does not match the intended samvardiq-staging project.');
  console.log('Target confirmation (non-secret metadata only):');
  console.log(`  deploy env : staging`);
  console.log(`  host       : ${target.host}`);
  console.log(`  port       : ${target.port}`);
  console.log(`  database   : ${target.database}`);
  console.log(`  packages to migrate, in order: ${MIGRATION_STEPS.map((s) => s.packageName).join(' -> ')}`);
  console.log('');

  try {
    await runMigrationChain(connectionString);
  } catch (error) {
    if (error instanceof MigrationStepError) {
      console.error(`--- ${error.packageName}: FAILED --- ${error.sqlState ? `[${error.sqlState}] ` : ''}${error.message}`);
      console.error("Migration for this package failed. Packages that already completed above remain applied (each package has an independent migration journal — see INFRA-W1A). Do not manually patch objects; investigate this package's own migration files, then re-run this script.");
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  console.log('\nAll four packages migrated successfully.');

  console.log('--- supabase platform hardening: applying ---');
  const admin = connectAdmin(connectionString);
  try {
    await applySupabaseHardening(admin.pool);
  } finally {
    await admin.close();
  }
  console.log('--- supabase platform hardening: done ---');
}

main().catch((error) => {
  console.error('Unexpected failure:', JSON.stringify(sanitizeError(error)));
  process.exitCode = 1;
});
