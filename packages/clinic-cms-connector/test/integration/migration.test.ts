import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import EmbeddedPostgres from 'embedded-postgres';

import { createPostgresClient, runMigrations } from '../../src/postgres/client.js';
import { stopEmbeddedPostgres } from './pgTeardown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');

const cleanupDirs: string[] = [];
after(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('CLINIC-W2B: upgrade migration from the canonical W1B-2 schema (0000-0001) succeeds, preserves pre-existing connections/evidence, and adds actor attribution without weakening anything', { timeout: 60_000 }, async (t) => {
  const port = 55702;
  const dataDir = path.join(os.tmpdir(), `samvardiq-clinic-connector-w2b-upgrade-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('clinic_connector_w2b_upgrade');
  const connectionString = `postgres://postgres:postgres@localhost:${port}/clinic_connector_w2b_upgrade`;
  const client = createPostgresClient({ connectionString });
  t.after(async () => {
    await client.close();
    await stopEmbeddedPostgres(pg, dataDir);
  });

  // Step 1: apply ONLY the canonical W1B-2 migrations (0000-0001).
  const w1bDir = path.join(os.tmpdir(), `samvardiq-clinic-connector-w1b-only-${Date.now()}`);
  cleanupDirs.push(w1bDir);
  fs.mkdirSync(path.join(w1bDir, 'meta'), { recursive: true });
  for (const f of ['0000_thin_raider.sql', '0001_rls_and_roles.sql']) {
    fs.copyFileSync(path.join(DRIZZLE_DIR, f), path.join(w1bDir, f));
  }
  for (const f of ['0000_snapshot.json', '0001_snapshot.json']) {
    fs.copyFileSync(path.join(DRIZZLE_DIR, 'meta', f), path.join(w1bDir, 'meta', f));
  }
  const fullJournal = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'));
  fs.writeFileSync(path.join(w1bDir, 'meta', '_journal.json'), JSON.stringify({ ...fullJournal, entries: fullJournal.entries.slice(0, 2) }));

  await runMigrations(client.db, w1bDir);

  // Insert pre-existing W1B-era data (owner role bypasses RLS — a superuser, not the app runtime role).
  await client.pool.query(
    `INSERT INTO clinic_cms_connections (organization_id, connection_id, base_url, key_id, secret_reference, approved_scopes, timezone, enabled) VALUES ('org-preexisting', 'conn-preexisting', 'https://clinic.example.com', 'key-1', 'env:X', '[]', 'Asia/Kolkata', true)`,
  );
  await client.pool.query(
    `INSERT INTO clinic_cms_connector_evidence (organization_id, evidence_id, connection_id, connector_type, operation, correlation_id, outcome, retry_count) VALUES ('org-preexisting', 'ev-preexisting', 'conn-preexisting', 'clinic-cms', 'listConsultants', 'corr-1', 'SUCCESS', 0)`,
  );

  // Step 2: apply the FULL migration chain (adds 0002) on top.
  await runMigrations(client.db, DRIZZLE_DIR);

  const { rows: connectionRows } = await client.pool.query(`SELECT * FROM clinic_cms_connections WHERE organization_id = 'org-preexisting'`);
  assert.equal(connectionRows.length, 1, 'the pre-existing connection row must survive the upgrade');
  assert.equal(connectionRows[0].connection_id, 'conn-preexisting');

  const { rows: evidenceRows } = await client.pool.query(`SELECT * FROM clinic_cms_connector_evidence WHERE organization_id = 'org-preexisting'`);
  assert.equal(evidenceRows.length, 1, 'the pre-existing evidence row must survive the upgrade');
  assert.equal(evidenceRows[0].actor_identity_id, null, 'a pre-W2B row has no actor attribution — must be null, not an error');
  assert.equal(evidenceRows[0].actor_principal_type, null);

  // A fresh write after the upgrade can populate the new columns.
  await client.pool.query(
    `INSERT INTO clinic_cms_connector_evidence (organization_id, evidence_id, connection_id, connector_type, operation, correlation_id, outcome, retry_count, actor_identity_id, actor_principal_type) VALUES ('org-preexisting', 'ev-postupgrade', 'conn-preexisting', 'clinic-cms', 'createAppointment', 'corr-2', 'SUCCESS', 0, 'id-service-1', 'service')`,
  );
  const { rows: postUpgradeRows } = await client.pool.query(`SELECT actor_identity_id, actor_principal_type FROM clinic_cms_connector_evidence WHERE evidence_id = 'ev-postupgrade'`);
  assert.equal(postUpgradeRows[0].actor_identity_id, 'id-service-1');
  assert.equal(postUpgradeRows[0].actor_principal_type, 'service');

  // The new check constraint still rejects an invalid principal type.
  await assert.rejects(
    client.pool.query(
      `INSERT INTO clinic_cms_connector_evidence (organization_id, evidence_id, connection_id, connector_type, operation, correlation_id, outcome, retry_count, actor_principal_type) VALUES ('org-preexisting', 'ev-bad', 'conn-preexisting', 'clinic-cms', 'listConsultants', 'corr-3', 'SUCCESS', 0, 'robot')`,
    ),
  );
});
