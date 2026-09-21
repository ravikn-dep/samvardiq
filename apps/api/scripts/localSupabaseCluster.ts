/**
 * INFRA-W1B — LOCAL REHEARSAL ONLY. Starts a disposable vanilla-PostgreSQL
 * cluster (embedded-postgres — a real postgres binary) shaped like Supabase
 * (see supabaseSimulation.ts), optionally migrates it with the canonical
 * chain and applies the staging hardening. Never touches any real project.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';

import { runMigrationChain } from './migrationChain.js';
import { connectAdmin, type AdminPostgres } from './stagingDb.js';
import { applySupabaseHardening } from './supabaseHardening.js';
import { SUPABASE_PLATFORM_SIMULATION } from './supabaseSimulation.js';

export interface LocalSupabaseCluster {
  owner: AdminPostgres;
  ownerUrl: string;
  /** Connection string for the runtime role (password random per run, never persisted). */
  appUrl: string;
  stop(): Promise<void>;
}

/**
 * embedded-postgres's Windows `stop()` can race the OS releasing file handles on
 * its own temp-dir removal (an upstream library race, identical to the one
 * documented in each package's own integration harness) — retry the removal.
 */
async function stopEmbedded(pg: EmbeddedPostgres, dataDir: string): Promise<void> {
  try {
    await pg.stop();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
    await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export async function startLocalSupabaseCluster(port: number, options: { migrate: boolean; harden: boolean }): Promise<LocalSupabaseCluster> {
  const dataDir = path.join(os.tmpdir(), `samvardiq-pg-supabase-sim-${port}-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('samvardiq_supabase_sim');

  const ownerUrl = `postgres://postgres:postgres@localhost:${port}/samvardiq_supabase_sim`;
  const owner = connectAdmin(ownerUrl);
  await owner.pool.query(SUPABASE_PLATFORM_SIMULATION);

  let appUrl = '';
  if (options.migrate) {
    await runMigrationChain(ownerUrl, () => undefined);
    const appPassword = crypto.randomBytes(24).toString('hex'); // [0-9a-f] only — safe to interpolate into ALTER ROLE
    await owner.pool.query(`ALTER ROLE samvardiq_app PASSWORD '${appPassword}'`);
    appUrl = `postgres://samvardiq_app:${appPassword}@localhost:${port}/samvardiq_supabase_sim`;
    if (options.harden) await applySupabaseHardening(owner.pool);
  }

  return {
    owner,
    ownerUrl,
    appUrl,
    async stop() {
      await owner.close();
      await stopEmbedded(pg, dataDir);
    },
  };
}
