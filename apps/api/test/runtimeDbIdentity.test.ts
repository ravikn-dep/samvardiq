import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { RuntimeDatabaseIdentityError, assertRuntimeDatabaseConfigured, assertRuntimeRole } from '../src/runtimeDbIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Step 17 regression: MIGRATION_DATABASE_URL must never be read as a value
 * (only ever compared) anywhere runtime code executes. A future refactor
 * that starts consuming it as a credential fails this test, not silently.
 */
test('no source file other than runtimeDbIdentity.ts reads MIGRATION_DATABASE_URL as a value (comparison only, never used as a credential)', () => {
  const srcDir = path.resolve(__dirname, '../src');
  const offenders: string[] = [];
  for (const file of fs.readdirSync(srcDir, { recursive: true }) as string[]) {
    if (!file.endsWith('.ts') || file.includes('runtimeDbIdentity.ts')) continue;
    const full = path.join(srcDir, file);
    if (fs.statSync(full).isDirectory()) continue;
    if (fs.readFileSync(full, 'utf8').includes('MIGRATION_DATABASE_URL')) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

/** INFRA-W1D: fail-closed runtime database identity — every malformed/misrouted input throws, never a silent fallback. */

const VALID_URL = 'postgres://samvardiq_app:x@db.example.com:5432/postgres';

test('DATABASE_URL missing fails closed', () => {
  assert.throws(() => assertRuntimeDatabaseConfigured({} as NodeJS.ProcessEnv), RuntimeDatabaseIdentityError);
});

test('DATABASE_URL identical to MIGRATION_DATABASE_URL fails closed (the runtime must never be the admin identity)', () => {
  assert.throws(
    () => assertRuntimeDatabaseConfigured({ DATABASE_URL: VALID_URL, MIGRATION_DATABASE_URL: VALID_URL } as unknown as NodeJS.ProcessEnv),
    RuntimeDatabaseIdentityError,
  );
});

test('a distinct MIGRATION_DATABASE_URL alongside DATABASE_URL is fine (e.g. a shared operator shell)', () => {
  const target = assertRuntimeDatabaseConfigured({ DATABASE_URL: VALID_URL, MIGRATION_DATABASE_URL: 'postgres://postgres:y@db.example.com:5432/postgres' } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(target, { host: 'db.example.com', port: '5432', database: 'postgres' });
});

test('a malformed DATABASE_URL fails closed', () => {
  assert.throws(() => assertRuntimeDatabaseConfigured({ DATABASE_URL: 'not a url' } as unknown as NodeJS.ProcessEnv), RuntimeDatabaseIdentityError);
});

test('a well-formed, distinct DATABASE_URL returns only non-secret target fields', () => {
  const target = assertRuntimeDatabaseConfigured({ DATABASE_URL: VALID_URL } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(target, { host: 'db.example.com', port: '5432', database: 'postgres' });
  assert.ok(!('user' in target) && !('password' in target));
});

function fakeQueryable(row: Record<string, unknown> | undefined) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

test('connected as anything other than samvardiq_app fails closed', async () => {
  await assert.rejects(
    assertRuntimeRole(fakeQueryable({ currentUser: 'postgres', currentDatabase: 'postgres', rolsuper: false, rolbypassrls: true, rolcreatedb: true, rolcreaterole: true, rolreplication: true })),
    RuntimeDatabaseIdentityError,
  );
});

test('samvardiq_app with any dangerous attribute fails closed (defense against a future misconfiguration)', async () => {
  for (const attr of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolreplication']) {
    await assert.rejects(
      assertRuntimeRole(fakeQueryable({ currentUser: 'samvardiq_app', currentDatabase: 'postgres', rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, [attr]: true })),
      RuntimeDatabaseIdentityError,
      `${attr} must fail closed`,
    );
  }
});

test('no matching pg_roles row fails closed rather than proceeding on an assumption', async () => {
  await assert.rejects(assertRuntimeRole(fakeQueryable(undefined)), RuntimeDatabaseIdentityError);
});

test('the correctly-shaped samvardiq_app role passes and returns its attributes', async () => {
  const attrs = await assertRuntimeRole(fakeQueryable({ currentUser: 'samvardiq_app', currentDatabase: 'postgres', rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false }));
  assert.equal(attrs.currentUser, 'samvardiq_app');
});
