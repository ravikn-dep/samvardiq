import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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

import {
  ACTIVE_KEY_VERSION_ENV,
  CredentialAccessDeniedError,
  type CredentialError,
  CredentialStoreError,
  InvalidCredentialInputError,
  KeyUnavailableError,
  MASTER_KEYS_ENV,
  MasterKeyRing,
  OAuthAuthorizationInvalidError,
  ProviderCredentialRejectedError,
  ProviderCredentialService,
  ProviderOAuthAuthorizations,
} from '../../src/index.js';
import { startHarness, type Harness } from './harness.js';

/**
 * GBP-W1 (Founder decision G2/G4): provider-neutral single-use OAuth state, as
 * the runtime role against real PostgreSQL. Letters refer to the GBP-W1
 * threat matrix (docs/integrations/GOOGLE_BUSINESS_PROFILE_ARCHITECTURE.md §10).
 */
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const PROVIDER = 'example_provider';
const REDIRECT = 'https://app.example.test/integrations/callback';
const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const ring = (keys: Record<number, string>, active: number) =>
  MasterKeyRing.fromEnv({ [MASTER_KEYS_ENV]: Object.entries(keys).map(([v, m]) => `${v}:${m}`).join(','), [ACTIVE_KEY_VERSION_ENV]: String(active) });

function human(organizationId: string, role: OrganizationRole, identityId = `${role.toLowerCase()}-${organizationId}`): TrustedOrganizationContext {
  return Object.freeze({ identityId, organizationId, membershipId: `${organizationId}::${identityId}`, role, principalType: 'human', establishedAt: new Date().toISOString() });
}

async function serviceContext(org: string): Promise<TrustedOrganizationContext> {
  const identities = new InMemoryIdentityRepository();
  const links = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const identityId = `svc-${org}`;
  await identities.create({ identityId, principalType: 'service', displayName: 'worker', status: 'active' });
  await links.create({ identityId, provider: 'platform-worker', providerSubject: identityId });
  await memberships.create({ organizationId: org, identityId, role: 'MEMBER', status: 'ACTIVE' });
  return new AuthorizationService(identities, links, memberships).resolveTrustedContext({
    principal: { provider: 'platform-worker', providerSubject: identityId, verifiedAt: new Date().toISOString() },
    requestedOrganizationId: org,
  });
}

async function rejectsWith(promise: Promise<unknown>, type: new (...args: never[]) => CredentialError): Promise<void> {
  await assert.rejects(promise, (e: unknown) => {
    assert.ok(e instanceof type, `expected ${type.name}, got ${inspect(e)}`);
    return true;
  });
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

describe('provider OAuth authorizations against real PostgreSQL', () => {
  let h: Harness;
  const ownerA = human(ORG_A, 'OWNER');
  const ownerA2 = human(ORG_A, 'OWNER', 'second-owner-a');
  const ownerB = human(ORG_B, 'OWNER');
  const RING = ring({ 1: K1 }, 1);
  const oauth = (keyRing = RING, ttlMs?: number) => new ProviderOAuthAuthorizations(h.app.db, keyRing, ttlMs);
  const begin = (actor = ownerA, svc = oauth()) => svc.begin(actor, { provider: PROVIDER, purpose: 'connect', redirectUri: REDIRECT });
  const consume = (state: string, actor = ownerA, svc = oauth(), provider = PROVIDER) => svc.consume(actor, { provider, purpose: 'connect', state });
  const rows = async () => (await h.owner.pool.query('select * from provider_oauth_authorizations order by created_at')).rows;

  before(async () => {
    h = await startHarness(55972);
  });
  after(async () => h.stop());
  beforeEach(async () => h.truncateAll());

  test('E/OAUTH-STATE: an OWNER begins; only the SHA-256 of the 256-bit state is stored, no verifier; consuming returns the redirect and a verifier matching the S256 challenge', async () => {
    const start = await begin();
    assert.match(start.state, /^[A-Za-z0-9_-]{43}$/);
    const [row] = await rows();
    assert.equal(row.state_hash, createHash('sha256').update(start.state).digest('hex'));
    assert.deepEqual(
      { org: row.organization_id, identity: row.identity_id, provider: row.provider, purpose: row.purpose, redirect: row.redirect_uri, keyVersion: row.key_version },
      { org: ORG_A, identity: ownerA.identityId, provider: PROVIDER, purpose: 'connect', redirect: REDIRECT, keyVersion: 1 },
    );
    const consumed = await consume(start.state);
    assert.equal(consumed.redirectUri, REDIRECT);
    assert.match(consumed.codeVerifier, /^[A-Za-z0-9_-]{43}$/, 'RFC 7636: 43+ unreserved characters');
    assert.equal(s256(consumed.codeVerifier), start.codeChallenge);
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes(start.state) && !dump.includes(consumed.codeVerifier) && !dump.includes(start.codeChallenge), 'the database never holds the state, verifier or challenge');
    assert.equal((await rows()).length, 0, 'consumption deletes the row');
  });

  test('two authorizations never share state or verifier', async () => {
    const [a, b] = [await begin(), await begin()];
    assert.notEqual(a.state, b.state);
    assert.notEqual(a.codeChallenge, b.codeChallenge);
  });

  test('B/C/D: MEMBER, VIEWER and a service principal cannot begin or consume', async () => {
    const start = await begin();
    const svc = await serviceContext(ORG_A);
    for (const actor of [human(ORG_A, 'MEMBER'), human(ORG_A, 'VIEWER'), svc]) {
      await rejectsWith(begin(actor), CredentialAccessDeniedError);
      await rejectsWith(consume(start.state, actor), CredentialAccessDeniedError);
    }
    assert.equal((await rows()).length, 1, 'the denied attempts did not consume the state');
  });

  test('F/G/AL: missing, malformed or altered state is refused without touching the stored authorization', async () => {
    const start = await begin();
    const altered = `${start.state.slice(0, -1)}${start.state.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of ['', 'short', `${start.state}x`, altered, "'; delete from provider_oauth_authorizations; --".padEnd(43, 'x'), undefined as unknown as string]) {
      await rejectsWith(consume(bad), OAuthAuthorizationInvalidError);
    }
    assert.equal((await rows()).length, 1);
    await consume(start.state);
  });

  test('H/N: a consumed state cannot be replayed', async () => {
    const start = await begin();
    await consume(start.state);
    await rejectsWith(consume(start.state), OAuthAuthorizationInvalidError);
  });

  test('I: an expired state is refused, and abandoned authorizations are swept by the next begin', async () => {
    const short = oauth(RING, 50);
    const start = await begin(ownerA, short);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await rejectsWith(consume(start.state, ownerA, short), OAuthAuthorizationInvalidError);
    assert.equal((await rows()).length, 1, 'the expired row is not consumed by a refused completion');
    await begin(ownerA, short);
    assert.equal((await rows()).length, 1, 'begin removed the expired row of this organization');
  });

  test('database lifetime cap: an authorization cannot be stored for longer than 15 minutes', async () => {
    await rejectsWith(begin(ownerA, oauth(RING, 16 * 60_000)), CredentialStoreError);
    assert.equal((await rows()).length, 0);
  });

  test('J/AD: another organization’s OWNER cannot consume (RLS hides the row) and the initiator still can', async () => {
    const start = await begin();
    await rejectsWith(consume(start.state, ownerB), OAuthAuthorizationInvalidError);
    await consume(start.state);
  });

  test('K/Z: a different OWNER of the same organization cannot consume (or burn) the initiator’s state', async () => {
    const start = await begin();
    await rejectsWith(consume(start.state, ownerA2), OAuthAuthorizationInvalidError);
    assert.equal((await rows()).length, 1);
    await consume(start.state);
  });

  test('state is bound to provider and purpose', async () => {
    const start = await begin();
    await rejectsWith(consume(start.state, ownerA, oauth(), 'other_provider'), OAuthAuthorizationInvalidError);
    await rejectsWith(oauth().consume(ownerA, { provider: PROVIDER, purpose: 'reconnect' as 'connect', state: start.state }), InvalidCredentialInputError);
    await consume(start.state);
  });

  test('AE: concurrent completions of one state — exactly one wins', async () => {
    const start = await begin();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => consume(start.state)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof OAuthAuthorizationInvalidError));
  });

  test('O: redirect URIs must be https (or http loopback), without fragment or userinfo', async () => {
    for (const redirectUri of ['http://app.example.test/cb', 'javascript:alert(1)', 'https://app.example.test/cb#x', 'https://u:p@app.example.test/cb', 'not a url', `https://e.test/${'a'.repeat(2050)}`]) {
      await rejectsWith(oauth().begin(ownerA, { provider: PROVIDER, purpose: 'connect', redirectUri }), InvalidCredentialInputError);
    }
    await oauth().begin(ownerA, { provider: PROVIDER, purpose: 'connect', redirectUri: 'http://127.0.0.1:53682/callback' });
  });

  test('key rotation: a verifier derives from the version recorded at begin; a removed version fails closed', async () => {
    const start = await begin(ownerA, oauth(ring({ 1: K1 }, 1)));
    await rejectsWith(consume(start.state, ownerA, oauth(ring({ 2: K2 }, 2))), KeyUnavailableError);
    const again = await begin(ownerA, oauth(ring({ 1: K1 }, 1)));
    const consumed = await consume(again.state, ownerA, oauth(ring({ 1: K1, 2: K2 }, 2)));
    assert.equal(s256(consumed.codeVerifier), again.codeChallenge, 'an older, still-held version still verifies');
  });

  test('RLS + grants: no context sees nothing; one organization cannot read another; the runtime role cannot UPDATE', async () => {
    await begin();
    await begin(ownerB);
    assert.equal((await h.app.pool.query('select * from provider_oauth_authorizations')).rows.length, 0);
    const client = await h.app.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select set_config('app.current_org_id', $1, true)`, [ORG_A]);
      assert.deepEqual((await client.query('select organization_id from provider_oauth_authorizations')).rows, [{ organization_id: ORG_A }]);
      await assert.rejects(client.query(`update provider_oauth_authorizations set identity_id = 'x'`), (e: { code?: string }) => e.code === '42501');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(`select set_config('app.current_org_id', $1, true)`, [ORG_A]);
      await assert.rejects(
        client.query(
          `insert into provider_oauth_authorizations (organization_id, authorization_id, state_hash, provider, purpose, identity_id, redirect_uri, key_version, expires_at)
           values ($1, 'x', $2, 'p_x', 'connect', 'i', 'https://e.test', 1, now() + interval '1 minute')`,
          [ORG_B, 'a'.repeat(64)],
        ),
        (e: { code?: string }) => e.code === '42501',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('AG/AI: a provider rejection inside useCredential moves the connection to NEEDS_REAUTH (audited) and refuses further use', async () => {
    const credentials = new ProviderCredentialService(h.app.db, RING);
    const svc = await serviceContext(ORG_A);
    const connection = await credentials.connect(ownerA, { provider: PROVIDER, grantedScopes: [], credentialType: 'oauth_refresh_token', secret: Buffer.from('rt') });
    assert.equal((await credentials.findOpenConnection(ownerA, PROVIDER))?.connectionId, connection.connectionId);
    assert.equal(await credentials.findOpenConnection(ownerB, PROVIDER), null, 'another organization sees no open connection');
    await rejectsWith(credentials.findOpenConnection(svc, PROVIDER), CredentialAccessDeniedError);

    await rejectsWith(
      credentials.useCredential(svc, connection.connectionId, 'oauth_refresh_token', async () => {
        throw new ProviderCredentialRejectedError();
      }),
      ProviderCredentialRejectedError,
    );
    assert.equal((await credentials.getConnection(ownerA, connection.connectionId)).status, 'NEEDS_REAUTH');
    const events = (await h.owner.pool.query(`select event_type, actor_principal_type from external_provider_credential_events order by occurred_at, event_type`)).rows;
    assert.ok(events.some((e) => e.event_type === 'CONNECTION_NEEDS_REAUTH' && e.actor_principal_type === 'service'));
    await assert.rejects(credentials.useCredential(svc, connection.connectionId, 'oauth_refresh_token', async () => true), (e: Error) => e.constructor.name === 'CredentialUnavailableError');
    assert.equal((await credentials.findOpenConnection(ownerA, PROVIDER))?.status, 'NEEDS_REAUTH', 'NEEDS_REAUTH is still the open connection');
    await credentials.disconnect(ownerA, connection.connectionId);
    assert.equal(await credentials.findOpenConnection(ownerA, PROVIDER), null);
  });
});
