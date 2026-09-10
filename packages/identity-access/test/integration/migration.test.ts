import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import EmbeddedPostgres from 'embedded-postgres';

import { createPostgresClient, runMigrations } from '../../src/postgres/client.js';

/** AP, AQ, AR — migration validation (section 37). Both paths against real, disposable PostgreSQL; neither ever touches a production database. */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');
const cleanupDirs: string[] = [];

after(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('AP: migration from empty succeeds, and is idempotent when the full chain is re-applied', async (t) => {
  const port = 55611;
  const dataDir = path.join(os.tmpdir(), `samvardiq-w6-migration-empty-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('w6_migration_empty');
  const client = createPostgresClient({ connectionString: `postgres://postgres:postgres@localhost:${port}/w6_migration_empty` });
  // The client must close BEFORE postgres stops — a single combined hook
  // guarantees that ordering regardless of node:test's after-hook order.
  t.after(async () => {
    await client.close();
    await pg.stop();
  });

  await runMigrations(client.db, DRIZZLE_DIR);

  const { rows } = await client.pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  assert.deepEqual(
    rows.map((r: { table_name: string }) => r.table_name),
    ['identities', 'identity_audit_events', 'identity_provider_links', 'organization_memberships'],
  );

  // Re-running the full chain must not error and must not duplicate/alter anything (drizzle's migrator tracks applied migrations).
  await assert.doesNotReject(runMigrations(client.db, DRIZZLE_DIR));
  const { rows: rowsAfterRerun } = await client.pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  assert.deepEqual(rowsAfterRerun.length, rows.length, 'idempotent re-run must not change the schema');
});

test('AQ: upgrade migration from the canonical W5 schema succeeds and preserves pre-existing data', async (t) => {
  const port = 55612;
  const dataDir = path.join(os.tmpdir(), `samvardiq-w6-migration-upgrade-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('w6_migration_upgrade');
  const connectionString = `postgres://postgres:postgres@localhost:${port}/w6_migration_upgrade`;
  const client = createPostgresClient({ connectionString });
  t.after(async () => {
    await client.close();
    await pg.stop();
  });

  // Step 1: apply ONLY the canonical W5 migrations (0000, 0001) from a filtered copy of the migrations folder.
  const w5Dir = path.join(os.tmpdir(), `samvardiq-w6-w5-only-migrations-${Date.now()}`);
  cleanupDirs.push(w5Dir);
  fs.mkdirSync(path.join(w5Dir, 'meta'), { recursive: true });
  for (const f of ['0000_messy_the_fury.sql', '0001_rls_membership_and_role.sql']) {
    fs.copyFileSync(path.join(DRIZZLE_DIR, f), path.join(w5Dir, f));
  }
  for (const f of ['0000_snapshot.json', '0001_snapshot.json']) {
    fs.copyFileSync(path.join(DRIZZLE_DIR, 'meta', f), path.join(w5Dir, 'meta', f));
  }
  const fullJournal = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'));
  fs.writeFileSync(path.join(w5Dir, 'meta', '_journal.json'), JSON.stringify({ ...fullJournal, entries: fullJournal.entries.slice(0, 2) }));

  await runMigrations(client.db, w5Dir);
  const { rows: w5Tables } = await client.pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  assert.deepEqual(w5Tables.map((r: { table_name: string }) => r.table_name), ['identities', 'identity_provider_links', 'organization_memberships']);

  // Insert pre-existing W5-era data.
  await client.pool.query(
    `INSERT INTO identities (identity_id, principal_type, display_name, status) VALUES ('id-preexisting', 'human', 'Pre-existing User', 'active')`,
  );
  // set_config with is_local=true resets after the statement's implicit transaction, so use an explicit transaction for the insert:
  await client.pool.query('BEGIN');
  await client.pool.query(`SELECT set_config('app.current_org_id', 'org-preexisting', true)`);
  await client.pool.query(
    `INSERT INTO organization_memberships (organization_id, identity_id, role, status) VALUES ('org-preexisting', 'id-preexisting', 'OWNER', 'ACTIVE')`,
  );
  await client.pool.query('COMMIT');

  // Step 2: apply the FULL migration chain (adds 0002, 0003) on top.
  await runMigrations(client.db, DRIZZLE_DIR);

  const { rows: identityRows } = await client.pool.query(`SELECT * FROM identities WHERE identity_id = 'id-preexisting'`);
  assert.equal(identityRows.length, 1, 'pre-existing identity row must survive the upgrade');

  const { rows: memberRows } = await client.pool.query(`SELECT * FROM organization_memberships WHERE organization_id = 'org-preexisting'`);
  assert.equal(memberRows.length, 1, 'pre-existing membership row must survive the upgrade');

  const { rows: finalTables } = await client.pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  assert.deepEqual(
    finalTables.map((r: { table_name: string }) => r.table_name),
    ['identities', 'identity_audit_events', 'identity_provider_links', 'organization_memberships'],
  );
});

test('AR: the upgrade migration does not corrupt or weaken canonical W5 RLS on organization_memberships', async (t) => {
  const port = 55613;
  const dataDir = path.join(os.tmpdir(), `samvardiq-w6-migration-rls-check-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('w6_migration_rls_check');
  const client = createPostgresClient({ connectionString: `postgres://postgres:postgres@localhost:${port}/w6_migration_rls_check` });
  t.after(async () => {
    await client.close();
    await pg.stop();
  });
  await runMigrations(client.db, DRIZZLE_DIR);

  const { rows } = await client.pool.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'organization_memberships'`,
  );
  assert.equal(rows[0].relrowsecurity, true, 'organization_memberships RLS must remain enabled after the W6 migration');
  assert.equal(rows[0].relforcerowsecurity, true, 'organization_memberships FORCE RLS must remain enabled after the W6 migration');

  const { rows: auditRlsRows } = await client.pool.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'identity_audit_events'`,
  );
  assert.equal(auditRlsRows[0].relrowsecurity, true);
  assert.equal(auditRlsRows[0].relforcerowsecurity, true);
});
