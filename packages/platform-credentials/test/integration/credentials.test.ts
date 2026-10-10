import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  AuthorizationService,
  InMemoryIdentityProviderLinkRepository,
  InMemoryIdentityRepository,
  InMemoryMembershipRepository,
  type OrganizationRole,
  type TrustedOrganizationContext,
} from '@samvardiq/identity-access';
import type { Pool } from 'pg';

import {
  ACTIVE_KEY_VERSION_ENV,
  assertKeyVersionRetirable,
  ConnectionConflictError,
  ConnectionNotFoundError,
  CredentialAccessDeniedError,
  CredentialError,
  CredentialInvalidError,
  CredentialKeyRotation,
  CredentialStoreError,
  CredentialUnavailableError,
  KeyUnavailableError,
  KeyVersionInUseError,
  keyVersionUsage,
  MASTER_KEYS_ENV,
  MasterKeyRing,
  ProviderCredentialRejectedError,
  ProviderCredentialService,
} from '../../src/index.js';
import { startHarness, type Harness } from './harness.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const PROVIDER = 'example_provider';
const REFRESH = 'oauth_refresh_token';

/** Ephemeral test keys — generated per run, never persisted or printed. */
const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const ring = (keys: Record<number, string>, active: number) =>
  MasterKeyRing.fromEnv({ [MASTER_KEYS_ENV]: Object.entries(keys).map(([v, m]) => `${v}:${m}`).join(','), [ACTIVE_KEY_VERSION_ENV]: String(active) });
const RING_1 = ring({ 1: K1 }, 1);
const RING_12 = ring({ 1: K1, 2: K2 }, 2);
const RING_2 = ring({ 2: K2 }, 2);

/** Distinctive plaintext markers so any leak is findable in any encoding. */
const secretFor = (label: string) => Buffer.from(`PLAINTEXT-${label}-${randomBytes(6).toString('hex')}`, 'utf8');
const encodings = (b: Buffer) => [b.toString('utf8'), b.toString('hex'), b.toString('base64')];

function human(organizationId: string, role: OrganizationRole, identityId = `${role.toLowerCase()}-${organizationId}`): TrustedOrganizationContext {
  return Object.freeze({ identityId, organizationId, membershipId: `${organizationId}::${identityId}`, role, principalType: 'human', establishedAt: new Date().toISOString() });
}

/** U: a real service context from the unmodified AuthorizationService (ADR-IDENTITY-002) — no fabricated OWNER, no impersonation. */
async function serviceContexts(): Promise<Record<string, TrustedOrganizationContext>> {
  const identities = new InMemoryIdentityRepository();
  const links = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const authz = new AuthorizationService(identities, links, memberships);
  const out: Record<string, TrustedOrganizationContext> = {};
  for (const org of [ORG_A, ORG_B]) {
    const identityId = `svc-worker-${org}`;
    await identities.create({ identityId, principalType: 'service', displayName: `worker ${org}`, status: 'active' });
    await links.create({ identityId, provider: 'platform-worker', providerSubject: identityId });
    await memberships.create({ organizationId: org, identityId, role: 'MEMBER', status: 'ACTIVE' });
    out[org] = await authz.resolveTrustedContext({ principal: { provider: 'platform-worker', providerSubject: identityId, verifiedAt: new Date().toISOString() }, requestedOrganizationId: org });
  }
  return out;
}

async function rejectsWith(promise: Promise<unknown>, type: new (...args: never[]) => CredentialError): Promise<CredentialError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${inspect(error)}`);
    return error;
  }
  assert.fail(`expected ${type.name}`);
}

async function expectSqlState(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (e: unknown) => (e as { code?: string }).code === code || (e as { cause?: { code?: string } }).cause?.code === code);
}

/** Runs SQL as the runtime role under an organization context, like withOrganizationContext does. */
async function asApp(pool: Pool, org: string | null, text: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (org) await client.query(`select set_config('app.current_org_id', $1, true)`, [org]);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Everything the database holds about credentials, rendered the way an attacker with a dump would see it. */
async function databaseDump(h: Harness): Promise<string> {
  const parts: string[] = [];
  for (const table of ['external_provider_connections', 'external_provider_credentials', 'external_provider_credential_events']) {
    const rows = await h.owner.pool.query(`select * from ${table}`);
    parts.push(JSON.stringify(rows.rows), inspect(rows.rows, { depth: 5, maxArrayLength: null }));
    for (const row of rows.rows) for (const v of Object.values(row)) if (Buffer.isBuffer(v)) parts.push(v.toString('utf8'), v.toString('hex'), v.toString('base64'));
  }
  return parts.join('\n');
}

describe('platform-credentials against real PostgreSQL', () => {
  let h: Harness;
  let svc: Record<string, TrustedOrganizationContext>;
  const ownerA = human(ORG_A, 'OWNER');
  const ownerB = human(ORG_B, 'OWNER');
  const use = (service: ProviderCredentialService, actor: TrustedOrganizationContext, connectionId: string, type = REFRESH) =>
    service.useCredential(actor, connectionId, type, async (s) => Buffer.from(s));

  before(async () => {
    h = await startHarness(55971);
    svc = await serviceContexts();
  });
  after(async () => h.stop());
  beforeEach(async () => h.truncateAll());

  const service = (keyRing = RING_1) => new ProviderCredentialService(h.app.db, keyRing);
  const connect = (actor = ownerA, secret = secretFor('a'), keyRing = RING_1, provider = PROVIDER) =>
    service(keyRing).connect(actor, { provider, externalAccountId: 'acct-1', grantedScopes: ['scope.read'], credentialType: REFRESH, secret });

  test('schema: three tables with RLS ENABLE + FORCE, tenant policies, and the exact minimum grants', async () => {
    const rls = await h.owner.pool.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class where relname like 'external_provider_%' and relkind = 'r' order by 1`,
    );
    assert.deepEqual(
      rls.rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity]),
      [
        ['external_provider_connections', true, true],
        ['external_provider_credential_events', true, true],
        ['external_provider_credentials', true, true],
      ],
    );
    const table = await h.owner.pool.query(
      `select table_name, string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants
        where grantee = 'samvardiq_app' and table_name like 'external_provider_%' group by 1 order by 1`,
    );
    assert.deepEqual(
      table.rows.map((r) => [r.table_name, r.p]),
      [
        ['external_provider_connections', 'INSERT,SELECT'],
        ['external_provider_credential_events', 'INSERT,SELECT'],
        ['external_provider_credentials', 'DELETE,INSERT,SELECT'],
      ],
    );
    const cols = await h.owner.pool.query(
      `select table_name, string_agg(column_name, ',' order by column_name) as c from information_schema.column_privileges
        where grantee = 'samvardiq_app' and privilege_type = 'UPDATE' and table_name like 'external_provider_%' group by 1 order by 1`,
    );
    assert.deepEqual(
      cols.rows.map((r) => [r.table_name, r.c]),
      [
        ['external_provider_connections', 'disconnected_at,external_account_id,granted_scopes,status,updated_at'],
        ['external_provider_credentials', 'key_check,key_version,rotated_at,wrap_nonce,wrap_tag,wrapped_key'],
      ],
    );
  });

  test('A/U: OWNER connects; the org service principal resolves exactly that secret inside the callback only', async () => {
    const secret = secretFor('u');
    const c = await connect(ownerA, secret);
    assert.equal(c.status, 'ACTIVE');
    assert.equal(c.credentials.length, 1);
    assert.equal(c.credentials[0]!.keyVersion, 1);
    let seen: Buffer | undefined;
    const result = await service().useCredential(svc[ORG_A]!, c.connectionId, REFRESH, async (s) => {
      seen = s;
      return s.toString('utf8');
    });
    assert.equal(result, secret.toString('utf8'));
    assert.ok(seen!.every((b) => b === 0), 'the plaintext buffer is zero-filled once the callback settles');
  });

  test('Q/R/S/T: only a human OWNER administers; MEMBER, VIEWER and service principals are denied before any database access', async () => {
    const c = await connect();
    for (const actor of [human(ORG_A, 'MEMBER'), human(ORG_A, 'VIEWER'), svc[ORG_A]!]) {
      await rejectsWith(service().connect(actor, { provider: PROVIDER, grantedScopes: [], credentialType: REFRESH, secret: secretFor('q') }), CredentialAccessDeniedError);
      await rejectsWith(service().reauthorize(actor, c.connectionId, { credentialType: REFRESH, secret: secretFor('r') }), CredentialAccessDeniedError);
      await rejectsWith(service().disconnect(actor, c.connectionId), CredentialAccessDeniedError);
      await rejectsWith(service().getConnection(actor, c.connectionId), CredentialAccessDeniedError);
    }
    const n = await h.owner.pool.query('select count(*)::int as n from external_provider_connections');
    assert.equal(n.rows[0].n, 1, 'no denied call created anything');
    assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'ACTIVE', 'and nothing was disconnected');
  });

  test('T: humans — even OWNER — cannot resolve plaintext; that path is service-principal only', async () => {
    const c = await connect();
    for (const actor of [ownerA, human(ORG_A, 'MEMBER'), human(ORG_A, 'VIEWER')]) await rejectsWith(use(service(), actor, c.connectionId), CredentialAccessDeniedError);
  });

  test('V: another organization\'s service principal cannot resolve — indistinguishable from a connection that does not exist', async () => {
    const c = await connect();
    const foreign = await rejectsWith(use(service(), svc[ORG_B]!, c.connectionId), CredentialUnavailableError);
    const missing = await rejectsWith(use(service(), svc[ORG_B]!, 'no-such-connection'), CredentialUnavailableError);
    assert.equal(foreign.message, missing.message);
    const adminForeign = await rejectsWith(service().getConnection(ownerB, c.connectionId), ConnectionNotFoundError);
    const adminMissing = await rejectsWith(service().getConnection(ownerB, 'no-such-connection'), ConnectionNotFoundError);
    assert.equal(adminForeign.message, adminMissing.message);
    await rejectsWith(service().disconnect(ownerB, c.connectionId), ConnectionNotFoundError);
    await rejectsWith(service().reauthorize(ownerB, c.connectionId, { credentialType: REFRESH, secret: secretFor('v') }), ConnectionNotFoundError);
    assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'ACTIVE');
  });

  test('W/X/Y: cross-organization SQL read, update, insert and delete are blocked by RLS (FORCE) for the runtime role', async () => {
    const c = await connect();
    for (const table of ['external_provider_connections', 'external_provider_credentials', 'external_provider_credential_events']) {
      assert.equal((await asApp(h.app.pool, ORG_B, `select * from ${table}`)).rowCount, 0, `${table}: org B sees nothing of org A`);
      assert.equal((await asApp(h.app.pool, null, `select * from ${table}`)).rowCount, 0, `${table}: no context sees nothing`);
      assert.ok((await asApp(h.app.pool, ORG_A, `select * from ${table}`)).rowCount! > 0, `${table}: org A sees its own rows (proof is not vacuous)`);
    }
    assert.equal((await asApp(h.app.pool, ORG_B, `update external_provider_connections set status = 'NEEDS_REAUTH' where connection_id = $1`, [c.connectionId])).rowCount, 0);
    assert.equal((await asApp(h.app.pool, ORG_B, `update external_provider_credentials set key_version = 9 where connection_id = $1`, [c.connectionId])).rowCount, 0);
    assert.equal((await asApp(h.app.pool, ORG_B, `delete from external_provider_credentials where connection_id = $1`, [c.connectionId])).rowCount, 0);
    await expectSqlState(
      asApp(h.app.pool, ORG_B, `insert into external_provider_connections (organization_id, connection_id, provider, status, granted_scopes, connected_by_identity_id) values ($1, 'x', 'p_x', 'ACTIVE', '[]', 'i')`, [ORG_A]),
      '42501',
    );
    const after = await h.owner.pool.query(`select k.status, count(c.*)::int as n from external_provider_connections k left join external_provider_credentials c using (organization_id, connection_id) group by 1`);
    assert.deepEqual(after.rows, [{ status: 'ACTIVE', n: 1 }], 'org A data unchanged');
  });

  test('grants: the runtime role cannot rewrite ciphertext or identity columns, delete connections, or alter/delete audit; audit is immutable even for the owner', async () => {
    const c = await connect();
    await expectSqlState(asApp(h.app.pool, ORG_A, `update external_provider_credentials set ciphertext = '\\x00'`), '42501');
    await expectSqlState(asApp(h.app.pool, ORG_A, `update external_provider_credentials set organization_id = 'org-b'`), '42501');
    await expectSqlState(asApp(h.app.pool, ORG_A, `update external_provider_connections set provider = 'other'`), '42501');
    await expectSqlState(asApp(h.app.pool, ORG_A, `update external_provider_connections set organization_id = 'org-b'`), '42501');
    await expectSqlState(asApp(h.app.pool, ORG_A, `delete from external_provider_connections where connection_id = $1`, [c.connectionId]), '42501');
    await expectSqlState(asApp(h.app.pool, ORG_A, `update external_provider_credential_events set event_type = 'CONNECTION_CREATED'`), '42501');
    await expectSqlState(asApp(h.app.pool, ORG_A, `delete from external_provider_credential_events`), '42501');
    await expectSqlState(h.owner.pool.query(`update external_provider_credential_events set event_type = 'CONNECTION_CREATED'`), 'P0001');
    await expectSqlState(h.owner.pool.query(`delete from external_provider_credential_events`), 'P0001');
    await expectSqlState(
      h.owner.pool.query(`update external_provider_credentials set provider = 'other_provider' where connection_id = $1`, [c.connectionId]),
      '23503',
    );
  });

  test('N: a NEEDS_REAUTH connection cannot resolve; O/AM: a disconnected one cannot either', async () => {
    const c = await connect();
    await h.owner.pool.query(`update external_provider_connections set status = 'NEEDS_REAUTH' where connection_id = $1`, [c.connectionId]);
    await rejectsWith(use(service(), svc[ORG_A]!, c.connectionId), CredentialUnavailableError);
    const d = await connect();
    await service().disconnect(ownerA, d.connectionId);
    await rejectsWith(use(service(), svc[ORG_A]!, d.connectionId), CredentialUnavailableError);
  });

  test('P: a deleted credential cannot resolve, even though its connection is ACTIVE', async () => {
    const c = await connect();
    await h.owner.pool.query(`delete from external_provider_credentials where connection_id = $1`, [c.connectionId]);
    assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'ACTIVE');
    await rejectsWith(use(service(), svc[ORG_A]!, c.connectionId), CredentialUnavailableError);
    await rejectsWith(use(service(), svc[ORG_A]!, c.connectionId, 'oauth_access_token'), CredentialUnavailableError);
  });

  test('AL/AM/AN: LOCAL disconnect deletes every ciphertext, blocks use, audits, claims no remote revocation, and is idempotent', async () => {
    const c = await connect();
    await service().reauthorize(ownerA, c.connectionId, { credentialType: 'api_key', secret: secretFor('second') });
    const result = await service().disconnect(ownerA, c.connectionId);
    assert.equal(result.remoteRevocation, 'NOT_ATTEMPTED');
    assert.equal(result.connection.status, 'DISCONNECTED');
    assert.ok(result.connection.disconnectedAt);
    assert.deepEqual(result.connection.credentials, []);
    assert.equal((await h.owner.pool.query('select count(*)::int as n from external_provider_credentials')).rows[0].n, 0);
    await rejectsWith(use(service(), svc[ORG_A]!, c.connectionId), CredentialUnavailableError);
    await rejectsWith(service().reauthorize(ownerA, c.connectionId, { credentialType: REFRESH, secret: secretFor('re') }), ConnectionConflictError);
    const again = await service().disconnect(ownerA, c.connectionId);
    assert.equal(again.remoteRevocation, 'NOT_ATTEMPTED');
    const ev = await h.owner.pool.query(`select event_type, count(*)::int as n from external_provider_credential_events group by 1 order by 1`);
    assert.deepEqual(
      ev.rows.map((r) => [r.event_type, r.n]),
      [['CONNECTION_CREATED', 1], ['CONNECTION_DISCONNECTED', 1], ['CREDENTIAL_DELETED', 2], ['CREDENTIAL_STORED', 2]],
      'one disconnect recorded; no event type claims a remote revocation',
    );
  });

  test('AK: re-authorization replaces the credential under a NEW ID, deletes the old ciphertext, and the old envelope cannot be replayed into the new row', async () => {
    const c = await connect(ownerA, secretFor('old'));
    const oldRow = (await h.owner.pool.query(`select * from external_provider_credentials where connection_id = $1`, [c.connectionId])).rows[0];
    const fresh = secretFor('new');
    const r = await service().reauthorize(ownerA, c.connectionId, { credentialType: REFRESH, secret: fresh, grantedScopes: ['scope.read', 'scope.write'] });
    assert.equal(r.credentials.length, 1);
    assert.notEqual(r.credentials[0]!.credentialId, oldRow.credential_id);
    assert.deepEqual(r.grantedScopes, ['scope.read', 'scope.write']);
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from external_provider_credentials where credential_id = $1`, [oldRow.credential_id])).rows[0].n, 0);
    assert.equal((await use(service(), svc[ORG_A]!, c.connectionId)).toString(), fresh.toString());
    await h.owner.pool.query(
      `update external_provider_credentials set ciphertext = $1, payload_nonce = $2, payload_tag = $3, wrapped_key = $4, wrap_nonce = $5, wrap_tag = $6, key_check = $7 where connection_id = $8`,
      [oldRow.ciphertext, oldRow.payload_nonce, oldRow.payload_tag, oldRow.wrapped_key, oldRow.wrap_nonce, oldRow.wrap_tag, oldRow.key_check, c.connectionId],
    );
    await rejectsWith(use(service(), svc[ORG_A]!, c.connectionId), CredentialInvalidError);
  });

  test('re-authorization moves NEEDS_REAUTH back to ACTIVE', async () => {
    const c = await connect();
    await h.owner.pool.query(`update external_provider_connections set status = 'NEEDS_REAUTH' where connection_id = $1`, [c.connectionId]);
    const fresh = secretFor('reauth');
    assert.equal((await service().reauthorize(ownerA, c.connectionId, { credentialType: REFRESH, secret: fresh })).status, 'ACTIVE');
    assert.equal((await use(service(), svc[ORG_A]!, c.connectionId)).toString(), fresh.toString());
  });

  test('J/K/L/M in the database: an envelope copied into another organization\'s, provider\'s, credential ID\'s or type\'s row fails authentication', async () => {
    const source = await connect(ownerA, secretFor('src'));
    const src = (await h.owner.pool.query(`select * from external_provider_credentials where connection_id = $1`, [source.connectionId])).rows[0];
    const transplant = async (connectionId: string, type = REFRESH) =>
      h.owner.pool.query(
        `update external_provider_credentials set ciphertext = $1, payload_nonce = $2, payload_tag = $3, wrapped_key = $4, wrap_nonce = $5, wrap_tag = $6, key_check = $7 where connection_id = $8 and credential_type = $9`,
        [src.ciphertext, src.payload_nonce, src.payload_tag, src.wrapped_key, src.wrap_nonce, src.wrap_tag, src.key_check, connectionId, type],
      );
    const targets = {
      organization: { conn: await connect(ownerB), actor: svc[ORG_B]!, type: REFRESH },
      provider: { conn: await connect(ownerA, secretFor('p'), RING_1, 'other_provider'), actor: svc[ORG_A]!, type: REFRESH },
      credentialId: { conn: await connect(ownerA), actor: svc[ORG_A]!, type: REFRESH },
      credentialType: { conn: source, actor: svc[ORG_A]!, type: 'api_key' },
    };
    await service().reauthorize(ownerA, source.connectionId, { credentialType: 'api_key', secret: secretFor('t') });
    for (const [name, t] of Object.entries(targets)) {
      assert.equal((await transplant(t.conn.connectionId, t.type)).rowCount, 1, name);
      await rejectsWith(use(service(), t.actor, t.conn.connectionId, t.type), CredentialInvalidError);
    }
    for (const t of Object.values(targets)) assert.equal((await service().getConnection(t.actor === svc[ORG_B] ? ownerB : ownerA, t.conn.connectionId)).status, 'NEEDS_REAUTH');
    // The type transplant targeted the source connection's own api_key row, so the whole source connection now needs re-authorization.
    await rejectsWith(use(service(), svc[ORG_A]!, source.connectionId), CredentialUnavailableError);
  });

  test('C (database): tampering marks the connection NEEDS_REAUTH, audited as the service actor; resolution then stays closed', async () => {
    const c = await connect();
    await h.owner.pool.query(`update external_provider_credentials set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) where connection_id = $1`, [c.connectionId]);
    await rejectsWith(use(service(), svc[ORG_A]!, c.connectionId), CredentialInvalidError);
    assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'NEEDS_REAUTH');
    const ev = await h.owner.pool.query(`select actor_principal_type, actor_identity_id from external_provider_credential_events where event_type = 'CONNECTION_NEEDS_REAUTH'`);
    assert.deepEqual(ev.rows, [{ actor_principal_type: 'service', actor_identity_id: svc[ORG_A]!.identityId }]);
    await rejectsWith(use(service(), svc[ORG_A]!, c.connectionId), CredentialUnavailableError);
  });

  test('AO/F/H: a ring missing the stored version, or holding a different key under it, fails closed as key_unavailable without forcing re-authorization', async () => {
    const c = await connect();
    await rejectsWith(use(service(RING_2), svc[ORG_A]!, c.connectionId), KeyUnavailableError);
    await rejectsWith(use(service(ring({ 1: K2 }, 1)), svc[ORG_A]!, c.connectionId), KeyUnavailableError);
    assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'ACTIVE', 'an operator key fault does not flip connections to NEEDS_REAUTH');
    assert.ok((await use(service(), svc[ORG_A]!, c.connectionId)).length > 0, 'and the correct ring still works');
  });

  test('AF/AG/AI/AJ: rotation re-wraps per credential, versions coexist, repeats are no-ops, and retirement is blocked while referenced', async () => {
    const secrets = [secretFor('r1'), secretFor('r2'), secretFor('r3')];
    const conns = [await connect(ownerA, secrets[0]), await connect(ownerA, secrets[1]), await connect(ownerB, secrets[2])];
    const before = (await h.owner.pool.query(`select credential_id, ciphertext from external_provider_credentials order by 1`)).rows;

    await assert.rejects(assertKeyVersionRetirable(h.owner.db, 1, 2), KeyVersionInUseError);
    await assert.rejects(assertKeyVersionRetirable(h.app.db, 1, 2), KeyVersionInUseError, 'an RLS-scoped connection can never certify retirement');
    await assert.rejects(keyVersionUsage(h.app.db), KeyVersionInUseError);

    const rotation = new CredentialKeyRotation(h.app.db, RING_12);
    assert.equal(await rotation.rewrapNext(ORG_A), true);
    const mixed = (await h.owner.pool.query(`select key_version, count(*)::int as n from external_provider_credentials group by 1 order by 1`)).rows;
    assert.deepEqual(mixed, [{ key_version: 1, n: 2 }, { key_version: 2, n: 1 }], 'AG: mixed versions coexist mid-rotation');
    for (const [i, c] of conns.entries()) assert.equal((await use(service(RING_12), svc[c.organizationId]!, c.connectionId)).toString(), secrets[i]!.toString());

    assert.equal(await rotation.rewrapOrganization(ORG_A), 1);
    await assert.rejects(assertKeyVersionRetirable(h.owner.db, 1, 2), KeyVersionInUseError, 'org B still references version 1');
    assert.deepEqual(
      (await keyVersionUsage(h.owner.db)).map((u) => [u.organizationId, u.keyVersion, u.credentials]),
      [[ORG_A, 2, 2], [ORG_B, 1, 1]],
    );
    assert.equal(await rotation.rewrapOrganization(ORG_B), 1);
    await assertKeyVersionRetirable(h.owner.db, 1, 2);
    await assert.rejects(assertKeyVersionRetirable(h.owner.db, 2, 2), KeyVersionInUseError, 'the active version is never retirable');

    const events = async () => (await h.owner.pool.query(`select count(*)::int as n from external_provider_credential_events where event_type = 'CREDENTIAL_REWRAPPED'`)).rows[0].n;
    assert.equal(await events(), 3);
    assert.equal(await rotation.rewrapOrganization(ORG_A), 0, 'AI: repeating rotation is a no-op');
    assert.equal(await rotation.rewrapOrganization(ORG_B), 0);
    assert.equal(await events(), 3);

    const afterRows = (await h.owner.pool.query(`select credential_id, ciphertext, rotated_at from external_provider_credentials order by 1`)).rows;
    assert.deepEqual(afterRows.map((r) => [r.credential_id, r.ciphertext]), before.map((r) => [r.credential_id, r.ciphertext]), 'payload ciphertext untouched by rotation');
    assert.ok(afterRows.every((r) => r.rotated_at instanceof Date));
    for (const [i, c] of conns.entries()) assert.equal((await use(service(RING_2), svc[c.organizationId]!, c.connectionId)).toString(), secrets[i]!.toString(), 'old key no longer needed');
    const sys = await h.owner.pool.query(`select distinct actor_principal_type, actor_identity_id from external_provider_credential_events where event_type = 'CREDENTIAL_REWRAPPED'`);
    assert.deepEqual(sys.rows, [{ actor_principal_type: 'system', actor_identity_id: null }]);
  });

  test('AH: a rotation step interrupted inside its transaction leaves the old envelope intact and usable; resuming completes it', async () => {
    const secret = secretFor('ah');
    const c = await connect(ownerA, secret);
    await h.owner.pool.query(`create function fail_rewrap_audit() returns trigger language plpgsql as $$ begin raise exception 'simulated crash'; end $$`);
    await h.owner.pool.query(`create trigger fail_rewrap_audit before insert on external_provider_credential_events for each row execute function fail_rewrap_audit()`);
    try {
      await assert.rejects(new CredentialKeyRotation(h.app.db, RING_12).rewrapNext(ORG_A));
    } finally {
      await h.owner.pool.query(`drop trigger fail_rewrap_audit on external_provider_credential_events; drop function fail_rewrap_audit()`);
    }
    const row = (await h.owner.pool.query(`select key_version, rotated_at from external_provider_credentials`)).rows[0];
    assert.deepEqual(row, { key_version: 1, rotated_at: null });
    assert.equal((await use(service(RING_1), svc[ORG_A]!, c.connectionId)).toString(), secret.toString(), 'still usable with only the old key');
    assert.equal(await new CredentialKeyRotation(h.app.db, RING_12).rewrapOrganization(ORG_A), 1);
    assert.equal((await use(service(RING_2), svc[ORG_A]!, c.connectionId)).toString(), secret.toString());
  });

  test('AT: a failure anywhere in connect or re-authorization rolls back everything — no connection without its credential, no lost credential', async () => {
    await h.owner.pool.query(`create function fail_audit() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$`);
    await h.owner.pool.query(`create trigger fail_audit before insert on external_provider_credential_events for each row execute function fail_audit()`);
    try {
      await assert.rejects(connect());
      const n = await h.owner.pool.query(`select (select count(*) from external_provider_connections)::int as c, (select count(*) from external_provider_credentials)::int as k`);
      assert.deepEqual(n.rows[0], { c: 0, k: 0 });
    } finally {
      await h.owner.pool.query(`drop trigger fail_audit on external_provider_credential_events; drop function fail_audit()`);
    }
    const original = secretFor('orig');
    const c = await connect(ownerA, original);
    await h.owner.pool.query(`update external_provider_connections set status = 'NEEDS_REAUTH' where connection_id = $1`, [c.connectionId]);
    await h.owner.pool.query(`create function fail_audit() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$`);
    await h.owner.pool.query(`create trigger fail_audit before insert on external_provider_credential_events for each row execute function fail_audit()`);
    try {
      await assert.rejects(service().reauthorize(ownerA, c.connectionId, { credentialType: REFRESH, secret: secretFor('lost') }));
    } finally {
      await h.owner.pool.query(`drop trigger fail_audit on external_provider_credential_events; drop function fail_audit()`);
    }
    const state = await service().getConnection(ownerA, c.connectionId);
    assert.equal(state.status, 'NEEDS_REAUTH', 'status not advanced');
    assert.equal(state.credentials[0]!.credentialId, c.credentials[0]!.credentialId, 'original credential kept');
  });

  test('AR: concurrent re-authorizations serialize — exactly one ciphertext remains and it is one of the submitted secrets', async () => {
    const c = await connect();
    const secrets = Array.from({ length: 6 }, (_, i) => secretFor(`race${i}`));
    const results = await Promise.allSettled(secrets.map((secret) => service().reauthorize(ownerA, c.connectionId, { credentialType: REFRESH, secret })));
    assert.ok(results.every((r) => r.status === 'fulfilled'), inspect(results.filter((r) => r.status === 'rejected')));
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from external_provider_credentials`)).rows[0].n, 1);
    const resolved = (await use(service(), svc[ORG_A]!, c.connectionId)).toString();
    assert.ok(secrets.some((s) => s.toString() === resolved));
    const ev = await h.owner.pool.query(`select event_type, count(*)::int as n from external_provider_credential_events group by 1 order by 1`);
    assert.deepEqual(ev.rows.map((r) => [r.event_type, r.n]), [['CONNECTION_CREATED', 1], ['CREDENTIAL_DELETED', 6], ['CREDENTIAL_REPLACED', 6], ['CREDENTIAL_STORED', 1]]);
  });

  test('AS: disconnect racing worker use fails safely — each use sees the full secret or a clean refusal, and nothing survives the disconnect', async () => {
    const secret = secretFor('as');
    const c = await connect(ownerA, secret);
    const uses = Array.from({ length: 12 }, () => use(service(), svc[ORG_A]!, c.connectionId));
    const [disconnect, ...outcomes] = await Promise.allSettled([service().disconnect(ownerA, c.connectionId), ...uses]);
    assert.equal(disconnect!.status, 'fulfilled');
    for (const o of outcomes) {
      if (o.status === 'fulfilled') assert.equal(o.value.toString(), secret.toString());
      else assert.ok(o.reason instanceof CredentialUnavailableError, inspect(o.reason));
    }
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from external_provider_credentials`)).rows[0].n, 0);
    await rejectsWith(use(service(), svc[ORG_A]!, c.connectionId), CredentialUnavailableError);
  });

  test('Z/AA/AQ/AB/AC/AD/AE: no plaintext (any encoding) in the database, returned metadata, logs, errors or audit', async () => {
    const secrets: Buffer[] = [];
    const captured: string[] = [];
    const errors: unknown[] = [];
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, out: process.stdout.write, err: process.stderr.write };
    const capture = (...args: unknown[]) => void captured.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 10 }))).join(' '));
    Object.assign(console, { log: capture, info: capture, warn: capture, error: capture, debug: capture });
    // Tee, never swallow: the test runner reports results over this process's stdout.
    const tee = (stream: NodeJS.WriteStream, original: typeof process.stdout.write) =>
      ((chunk: unknown, ...rest: unknown[]) => (captured.push(String(chunk)), (original as (...a: unknown[]) => boolean).call(stream, chunk, ...rest))) as typeof process.stdout.write;
    process.stdout.write = tee(process.stdout, originals.out);
    process.stderr.write = tee(process.stderr, originals.err);
    const returned: unknown[] = [];
    try {
      const s1 = secretFor('leak1');
      const s2 = secretFor('leak2');
      secrets.push(s1, s2);
      const c = await connect(ownerA, s1);
      returned.push(c, await service().reauthorize(ownerA, c.connectionId, { credentialType: REFRESH, secret: s2 }), await service().getConnection(ownerA, c.connectionId));
      await use(service(), svc[ORG_A]!, c.connectionId);
      await new CredentialKeyRotation(h.app.db, RING_12).rewrapOrganization(ORG_A);
      for (const p of [
        () => use(service(RING_1), svc[ORG_A]!, c.connectionId),
        () => use(service(RING_12), svc[ORG_B]!, c.connectionId),
        () => use(service(RING_12), ownerA, c.connectionId),
        () => service(RING_12).connect(ownerA, { provider: 'Bad Provider', grantedScopes: [], credentialType: REFRESH, secret: s1 }),
        () => assertKeyVersionRetirable(h.owner.db, 2, 2),
      ]) {
        try {
          await p();
        } catch (e) {
          errors.push(e);
        }
      }
      await h.owner.pool.query(`update external_provider_credentials set wrap_tag = set_byte(wrap_tag, 0, get_byte(wrap_tag, 0) # 1)`);
      try {
        await use(service(RING_12), svc[ORG_A]!, c.connectionId);
      } catch (e) {
        errors.push(e);
      }
      returned.push(await service().disconnect(ownerA, c.connectionId));
    } finally {
      Object.assign(console, { log: originals.log, info: originals.info, warn: originals.warn, error: originals.error, debug: originals.debug });
      process.stdout.write = originals.out;
      process.stderr.write = originals.err;
    }
    assert.equal(errors.length, 6);
    assert.ok(errors.every((e) => e instanceof CredentialError), inspect(errors));
    const forbidden = [...secrets.flatMap(encodings), K1, K2, Buffer.from(K1, 'base64').toString('hex'), Buffer.from(K2, 'base64').toString('hex')];
    const surfaces: Record<string, string> = {
      'AA/AQ database dump': await databaseDump(h),
      'AB returned metadata': JSON.stringify(returned) + inspect(returned, { depth: 10 }),
      'AC logs': captured.join('\n'),
      'AD errors': errors.map((e) => `${String(e)} ${(e as Error).stack} ${JSON.stringify(e)} ${inspect(e, { depth: 10, showHidden: true })}`).join('\n'),
    };
    for (const [surface, text] of Object.entries(surfaces)) for (const f of forbidden) assert.ok(!text.includes(f), `${surface} contains secret or key material`);
    for (const r of returned) {
      const keys = JSON.stringify(r);
      for (const field of ['ciphertext', 'wrappedKey', 'wrapped_key', 'payloadTag', 'keyCheck', 'nonce']) assert.ok(!keys.includes(field), `metadata exposes ${field}`);
    }
    const auditColumns = (await h.owner.pool.query(`select column_name from information_schema.columns where table_name = 'external_provider_credential_events' order by 1`)).rows.map((r) => r.column_name);
    assert.deepEqual(auditColumns, ['actor_identity_id', 'actor_principal_type', 'connection_id', 'credential_id', 'event_id', 'event_type', 'key_version', 'occurred_at', 'organization_id'], 'AE: audit holds identifiers only');
    const connectionColumns = (await h.owner.pool.query(`select column_name from information_schema.columns where table_name = 'external_provider_connections'`)).rows.map((r) => r.column_name);
    assert.ok(!connectionColumns.some((c: string) => /secret|token|cipher|key/.test(c)), 'Z: connection metadata has no secret-bearing column');
  });

  test('AD (database failure): an error while writing an envelope surfaces only a sanitized CredentialStoreError — never the query or its envelope parameters', async () => {
    await h.owner.pool.query(`create function fail_credential_insert() returns trigger language plpgsql as $$ begin raise exception 'simulated store failure'; end $$`);
    await h.owner.pool.query(`create trigger fail_credential_insert before insert on external_provider_credentials for each row execute function fail_credential_insert()`);
    try {
      const error = await rejectsWith(connect(), CredentialStoreError);
      assert.equal((error as CredentialStoreError).sqlState, 'P0001');
      assert.equal((error as Error).cause, undefined);
      const rendered = `${String(error)} ${(error as Error).stack} ${JSON.stringify(error)} ${inspect(error, { depth: 10, showHidden: true })}`;
      for (const leak of ['insert into', 'params', 'simulated store failure', 'external_provider_credentials']) assert.ok(!rendered.includes(leak), `error exposes "${leak}"`);
    } finally {
      await h.owner.pool.query(`drop trigger fail_credential_insert on external_provider_credentials; drop function fail_credential_insert()`);
    }
  });

  test('NEEDS_REAUTH race: a worker that failed on a credential an OWNER is replacing at that moment does not undo the re-authorization', async () => {
    const c = await connect();
    await h.owner.pool.query(`update external_provider_credentials set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)`);
    const replacer = await h.owner.pool.connect();
    try {
      // The replacing transaction holds the connection lock (as reauthorize does) while the worker reads the bad row and fails.
      await replacer.query('BEGIN');
      await replacer.query(`select 1 from external_provider_connections where connection_id = $1 for update`, [c.connectionId]);
      const worker = use(service(), svc[ORG_A]!, c.connectionId).then(
        () => assert.fail('the tampered credential must not resolve'),
        (e: unknown) => e,
      );
      await new Promise((resolve) => setTimeout(resolve, 300)); // the worker is now blocked on the connection lock, inside #markNeedsReauth
      await replacer.query(`delete from external_provider_credentials where connection_id = $1`, [c.connectionId]);
      await replacer.query('COMMIT');
      assert.ok((await worker) instanceof CredentialInvalidError);
    } finally {
      replacer.release();
    }
    assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'ACTIVE', 'the replaced connection stays ACTIVE');
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from external_provider_credential_events where event_type = 'CONNECTION_NEEDS_REAUTH'`)).rows[0].n, 0);
  });

  test('BF/BN (GBP-W1 rotation): a provider-rotated successor is stored by compare-and-swap — never over a newer credential, never into a disconnected connection', async () => {
    const c = await connect();
    const latest = async () => use(service(), svc[ORG_A]!, c.connectionId);

    // Normal rotation: the successor replaces the used credential (new credential ID), audited as the service principal.
    const rotated = secretFor('rotated');
    assert.equal(await service().useCredential(svc[ORG_A]!, c.connectionId, REFRESH, async (_s, k) => k.replace(rotated)), true);
    assert.deepEqual(await latest(), rotated);
    const ids = (await h.owner.pool.query(`select credential_id from external_provider_credentials`)).rows;
    assert.equal(ids.length, 1);
    assert.notEqual(ids[0].credential_id, c.credentials[0]!.credentialId);
    assert.equal((await h.owner.pool.query(`select actor_principal_type from external_provider_credential_events where event_type = 'CREDENTIAL_REPLACED'`)).rows[0].actor_principal_type, 'service');

    // Stale write: an OWNER re-authorizes while a use of the old credential is in flight — the late successor is discarded.
    const owners = secretFor('owner-reauth');
    const stale = await service().useCredential(svc[ORG_A]!, c.connectionId, REFRESH, async (_s, k) => {
      await service().reauthorize(ownerA, c.connectionId, { credentialType: REFRESH, secret: owners });
      return k.replace(secretFor('stale'));
    });
    assert.equal(stale, false);
    assert.deepEqual(await latest(), owners);

    // Two concurrent uses of one credential both receive a successor: exactly one is stored.
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const results = await Promise.all(
      [1, 2].map((n) =>
        service().useCredential(svc[ORG_A]!, c.connectionId, REFRESH, async (_s, k) => {
          if (++arrived === 2) release(); // both hold the SAME credential before either replaces it
          await barrier;
          return k.replace(secretFor(`race-${n}`));
        }),
      ),
    );
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from external_provider_credentials`)).rows[0].n, 1);

    // Disconnect during use: the successor never revives the connection.
    const revived = await service().useCredential(svc[ORG_A]!, c.connectionId, REFRESH, async (_s, k) => {
      await service().disconnect(ownerA, c.connectionId);
      return k.replace(secretFor('after-disconnect'));
    });
    assert.equal(revived, false);
    assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'DISCONNECTED');
    assert.equal((await h.owner.pool.query(`select count(*)::int as n from external_provider_credentials`)).rows[0].n, 0);
  });

  test('rotation race: a concurrent use that failed on the superseded credential (NEEDS_REAUTH) is healed by the successor the provider just issued', async () => {
    const c = await connect();
    const successor = secretFor('successor');
    const stored = await service().useCredential(svc[ORG_A]!, c.connectionId, REFRESH, async (_s, k) => {
      // A concurrent use of the same credential was rejected by the provider first (old token already rotated away).
      await service().useCredential(svc[ORG_A]!, c.connectionId, REFRESH, async () => {
        throw new ProviderCredentialRejectedError();
      }).catch(() => undefined);
      assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'NEEDS_REAUTH');
      return k.replace(successor);
    });
    assert.equal(stored, true);
    assert.equal((await service().getConnection(ownerA, c.connectionId)).status, 'ACTIVE');
    assert.deepEqual(await use(service(), svc[ORG_A]!, c.connectionId), successor);
  });
});
