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
import {
  ACTIVE_KEY_VERSION_ENV,
  CredentialAccessDeniedError,
  CredentialStoreError,
  CredentialUnavailableError,
  MASTER_KEYS_ENV,
  MasterKeyRing,
  OAuthAuthorizationInvalidError,
  ProviderCredentialRejectedError,
  ProviderCredentialService,
  ProviderOAuthAuthorizations,
  createPostgresClient as createCredentialsClient,
} from '@samvardiq/platform-credentials';

import {
  classifyGbpError,
  GbpConflictError,
  GbpConnectionService,
  GbpInvalidRequestError,
  GbpLocationNotAvailableError,
  GbpReadClient,
  GbpRedirectUriNotAllowedError,
  gbpDatabase,
  GoogleAccountMismatchError,
  GoogleAuthorizationDeniedError,
  GoogleAuthorizationRejectedError,
  GoogleOAuthClient,
  GoogleRateLimitedError,
  GoogleResponseInvalidError,
  GoogleScopeNotGrantedError,
  GoogleUnavailableError,
} from '../../src/index.js';
import { FakeGoogle, googleUser, type GoogleUser } from '../fakeGoogle.js';
import { startHarness, type Harness } from './harness.js';

/**
 * GBP-W1 against real PostgreSQL (runtime role samvardiq_app, RLS + FORCE RLS)
 * with an emulated Google. Letters are the GBP-W1 threat matrix
 * (docs/integrations/GOOGLE_BUSINESS_PROFILE_ARCHITECTURE.md §10).
 */
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const REDIRECT = 'https://app.example.test/integrations/google-business-profile/callback';
const RING = MasterKeyRing.fromEnv({ [MASTER_KEYS_ENV]: `1:${randomBytes(32).toString('base64')}`, [ACTIVE_KEY_VERSION_ENV]: '1' });

function human(organizationId: string, role: OrganizationRole, identityId = `${role.toLowerCase()}-${organizationId}`): TrustedOrganizationContext {
  return Object.freeze({ identityId, organizationId, membershipId: `${organizationId}::${identityId}`, role, principalType: 'human', establishedAt: new Date().toISOString() });
}

async function serviceContext(org: string): Promise<TrustedOrganizationContext> {
  const identities = new InMemoryIdentityRepository();
  const links = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const identityId = `svc-${org}`;
  await identities.create({ identityId, principalType: 'service', displayName: 'gbp sync', status: 'active' });
  await links.create({ identityId, provider: 'platform-worker', providerSubject: identityId });
  await memberships.create({ organizationId: org, identityId, role: 'MEMBER', status: 'ACTIVE' });
  return new AuthorizationService(identities, links, memberships).resolveTrustedContext({
    principal: { provider: 'platform-worker', providerSubject: identityId, verifiedAt: new Date().toISOString() },
    requestedOrganizationId: org,
  });
}

/** Clinic owner's Google login: personal account 111 plus a location group 222. Location 9001 is also managed by the second user (agency). */
const clinicOwner = () =>
  googleUser('111', {
    groups: [{ id: '222', name: 'Clinic Group' }],
    locations: {
      '111': [{ id: '9001', title: 'Dr. Example Orthopaedic Clinic', address: { addressLines: ['1 Main Road'], locality: 'Hyderabad', postalCode: '500001' } }],
      '222': [{ id: '9002', title: 'Example Clinic — Branch' }, { id: '9001', title: 'Dr. Example Orthopaedic Clinic (dup)' }],
    },
  });
const agency = () => googleUser('333', { locations: { '333': [{ id: '9001', title: 'Shared location' }, { id: '9003', title: 'Agency-only location' }] } });

async function rejectsWith(promise: Promise<unknown>, type: abstract new (...args: never[]) => Error, check?: (e: Error) => void): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${inspect(error)}`);
    check?.(error);
    return error;
  }
  assert.fail(`expected ${type.name}`);
}

describe('GBP-W1 connection against real PostgreSQL', () => {
  let h: Harness;
  let google: FakeGoogle;
  let svc: GbpConnectionService;
  let credentials: ProviderCredentialService;
  const ownerA = human(ORG_A, 'OWNER');
  const ownerB = human(ORG_B, 'OWNER');

  const build = (overrides: Partial<ConstructorParameters<typeof GbpConnectionService>[0]> = {}) =>
    new GbpConnectionService({
      db: h.appGbp,
      credentials,
      authorizations: new ProviderOAuthAuthorizations(h.app.db, RING),
      oauth: new GoogleOAuthClient({ clientId: google.clientId, clientSecret: google.clientSecret }, google.fetch),
      gbp: new GbpReadClient(google.fetch),
      redirectUris: [REDIRECT, 'http://127.0.0.1:53682/callback'],
      ...overrides,
    });

  /** The whole OWNER flow: begin → Google consent → complete. */
  async function connect(actor: TrustedOrganizationContext, user: GoogleUser, service = svc) {
    const { authorizationUrl } = await service.beginAuthorization(actor, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, user);
    return service.completeAuthorization(actor, { state, code });
  }

  /** Everything the database holds, the way an attacker with a dump would see it. */
  async function dump(): Promise<string> {
    const parts: string[] = [];
    for (const table of ['provider_oauth_authorizations', 'external_provider_connections', 'external_provider_credentials', 'external_provider_credential_events', 'gbp_location_candidates', 'gbp_location_bindings']) {
      const rows = (await h.owner.pool.query(`select * from ${table}`)).rows;
      parts.push(JSON.stringify(rows));
      for (const row of rows) for (const v of Object.values(row)) if (Buffer.isBuffer(v)) parts.push(v.toString('utf8'), v.toString('base64'), v.toString('hex'));
    }
    return parts.join('\n');
  }

  const count = async (table: string, where = 'true') => Number((await h.owner.pool.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0].n);

  before(async () => {
    h = await startHarness(55973);
  });
  after(async () => h.stop());
  beforeEach(async () => {
    await h.truncateAll();
    google = new FakeGoogle();
    credentials = new ProviderCredentialService(h.app.db, RING);
    svc = build();
  });

  test('E: an OWNER connects — PKCE S256, offline access, consent; the refresh token is stored only as ARCH-020 ciphertext; candidates are discovered; nothing is bound', async () => {
    const { authorizationUrl, expiresAt } = await svc.beginAuthorization(ownerA, REDIRECT);
    const p = new URL(authorizationUrl).searchParams;
    assert.deepEqual(
      { scope: p.get('scope'), access: p.get('access_type'), prompt: p.get('prompt'), method: p.get('code_challenge_method'), type: p.get('response_type'), redirect: p.get('redirect_uri') },
      { scope: 'https://www.googleapis.com/auth/business.manage', access: 'offline', prompt: 'consent', method: 'S256', type: 'code', redirect: REDIRECT },
    );
    assert.ok(!authorizationUrl.includes(google.clientSecret), 'the client secret never goes into the browser URL');
    assert.ok(Date.parse(expiresAt) - Date.now() <= 10 * 60_000 + 1000);

    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    const status = await svc.completeAuthorization(ownerA, { state, code });
    assert.equal(status.connection?.status, 'ACTIVE');
    assert.equal(status.connection?.googleAccountId, 'accounts/111');
    assert.deepEqual(status.connection?.grantedScopes, ['https://www.googleapis.com/auth/business.manage']);
    assert.deepEqual(status.candidates.map((c) => c.locationName).sort(), ['locations/9001', 'locations/9002'], 'deduplicated across the accounts Google returned');
    assert.equal(status.binding, null, 'G1/D: seeing a location never binds it');
    assert.equal(await count('external_provider_credentials'), 1);

    const db = await dump();
    for (const value of google.issued) assert.ok(!db.includes(value), 'V/W: no token or code in any table, in any encoding');
    assert.ok(!db.includes(google.clientSecret));
    assert.ok(!JSON.stringify(status).match(/ya29\.|1\/\/0g|4\/0A/), 'no token-shaped value in the OWNER-visible status');
  });

  test('read-only boundary in practice: every business request is a GET to the two read endpoints; the only POST is the OAuth token exchange', async () => {
    await connect(ownerA, clinicOwner());
    const status = await svc.status(ownerA);
    await svc.bind(ownerA, status.candidates[0]!.locationName);
    await svc.validateConnection(await serviceContext(ORG_A), status.connection!.connectionId);
    for (const r of google.requests) {
      if (r.method === 'POST') assert.equal(r.url, 'https://oauth2.googleapis.com/token');
      else {
        assert.equal(r.method, 'GET');
        assert.match(r.url, /^https:\/\/(mybusinessaccountmanagement\.googleapis\.com\/v1\/accounts\?|mybusinessbusinessinformation\.googleapis\.com\/v1\/accounts\/[^/]+\/locations\?)/);
        assert.ok(!r.url.includes('ya29.'), 'access tokens travel only in the Authorization header');
      }
    }
    assert.equal(google.requests.filter((r) => r.method === 'POST').length, 2, 'one code exchange + one refresh');
  });

  test('explicit binding: OWNER binds a discovered location; status shows it; stable resource names are the identity', async () => {
    await connect(ownerA, clinicOwner());
    const status = await svc.bind(ownerA, 'locations/9002');
    assert.deepEqual({ name: status.binding?.locationName, account: status.binding?.accountName, by: status.binding?.boundByIdentityId }, { name: 'locations/9002', account: 'accounts/222', by: ownerA.identityId });
  });

  test('AB/AL: a location not returned for this connection, or a malformed name, cannot be bound', async () => {
    await connect(ownerA, clinicOwner());
    await rejectsWith(svc.bind(ownerA, 'locations/9003'), GbpLocationNotAvailableError);
    for (const bad of ['9001', 'locations/', 'locations/9001/reviews', "locations/1' or '1'='1", 'accounts/111']) await rejectsWith(svc.bind(ownerA, bad), GbpInvalidRequestError);
    assert.equal(await count('gbp_location_bindings'), 0);
  });

  test('AC/AD: another organization’s candidates are invisible — org A cannot bind a location only org B’s Google account returned', async () => {
    await connect(ownerA, clinicOwner());
    await connect(ownerB, agency());
    await rejectsWith(svc.bind(ownerA, 'locations/9003'), GbpLocationNotAvailableError);
    assert.deepEqual((await svc.status(ownerA)).candidates.map((c) => c.locationName).sort(), ['locations/9001', 'locations/9002']);
  });

  test('AN: a location is actively bound to at most one organization; after the first unbinds, the second may bind', async () => {
    await connect(ownerA, clinicOwner());
    await connect(ownerB, agency());
    await svc.bind(ownerA, 'locations/9001');
    await rejectsWith(svc.bind(ownerB, 'locations/9001'), GbpConflictError, (e) => assert.equal((e as GbpConflictError).kind, 'bound_elsewhere'));
    await svc.unbind(ownerA);
    assert.equal((await svc.bind(ownerB, 'locations/9001')).binding?.locationName, 'locations/9001');
  });

  test('G3: one active binding per organization; changing it is unbind + bind; history is kept', async () => {
    await connect(ownerA, clinicOwner());
    await svc.bind(ownerA, 'locations/9001');
    await rejectsWith(svc.bind(ownerA, 'locations/9002'), GbpConflictError, (e) => assert.equal((e as GbpConflictError).kind, 'already_bound'));
    await svc.unbind(ownerA);
    await svc.unbind(ownerA); // idempotent
    await svc.bind(ownerA, 'locations/9002');
    const history = (await h.owner.pool.query(`select location_name, unbind_reason from gbp_location_bindings order by bound_at`)).rows;
    assert.deepEqual(history, [{ location_name: 'locations/9001', unbind_reason: 'OWNER_UNBOUND' }, { location_name: 'locations/9002', unbind_reason: null }]);
  });

  test('concurrent binds of one organization: exactly one wins (database-enforced)', async () => {
    await connect(ownerA, clinicOwner());
    const results = await Promise.allSettled(['locations/9001', 'locations/9002', 'locations/9001'].map((l) => svc.bind(ownerA, l)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await count('gbp_location_bindings', 'unbound_at is null'), 1);
  });

  test('G3: the same Google account re-authorizes (credential replaced, binding kept while still returned); a location no longer returned is unbound', async () => {
    const user = clinicOwner();
    const first = await connect(ownerA, user);
    await svc.bind(ownerA, 'locations/9002');
    const again = await connect(ownerA, user);
    assert.equal(again.connection?.connectionId, first.connection?.connectionId, 'same connection, re-authorized');
    assert.equal(again.binding?.locationName, 'locations/9002');
    assert.equal(await count('external_provider_credentials'), 1, 'exactly one ciphertext after replacement');

    user.locations['accounts/222'] = [];
    const third = await connect(ownerA, user);
    assert.equal(third.binding, null);
    assert.deepEqual(third.candidates.map((c) => c.locationName), ['locations/9001']);
    assert.equal((await h.owner.pool.query(`select unbind_reason from gbp_location_bindings`)).rows[0].unbind_reason, 'LOCATION_NOT_RETURNED');
  });

  test('G3: a different Google account is refused until a controlled disconnect; nothing it returned is stored', async () => {
    await connect(ownerA, clinicOwner());
    await svc.bind(ownerA, 'locations/9001');
    const before = await dump();
    await rejectsWith(connect(ownerA, agency()), GoogleAccountMismatchError);
    assert.equal(await dump(), before, 'credential, candidates and binding unchanged; the state was consumed (row gone either way)');
    await svc.disconnect(ownerA);
    const fresh = await connect(ownerA, agency());
    assert.equal(fresh.connection?.googleAccountId, 'accounts/333');
    assert.notEqual(fresh.connection?.connectionId, undefined);
  });

  test('disconnect (G1/G3/AO): local only — DISCONNECTED, ciphertext deleted, binding ended with history, candidates removed, Google NOT revoked; idempotent; background use refused', async () => {
    const status = await connect(ownerA, clinicOwner());
    await svc.bind(ownerA, 'locations/9001');
    const connectionId = status.connection!.connectionId;
    const service = await serviceContext(ORG_A);

    const result = await svc.disconnect(ownerA);
    assert.equal(result.googleAuthorization, 'NOT_REVOKED');
    assert.deepEqual({ connection: result.connection, binding: result.binding, candidates: result.candidates }, { connection: null, binding: null, candidates: [] });
    assert.equal(await count('external_provider_credentials'), 0);
    assert.equal((await h.owner.pool.query(`select unbind_reason from gbp_location_bindings`)).rows[0].unbind_reason, 'CONNECTION_DISCONNECTED');
    assert.equal(await count('gbp_location_candidates'), 0);
    assert.equal(google.requests.filter((r) => r.url.includes('revoke')).length, 0, 'no claim — and no attempt — of Google-side revocation');
    await rejectsWith(svc.validateConnection(service, connectionId), CredentialUnavailableError);
    await svc.disconnect(ownerA);
  });

  test('U: a disconnect interrupted after the credential step converges when re-run', async () => {
    await connect(ownerA, clinicOwner());
    await svc.bind(ownerA, 'locations/9001');
    const dead = createCredentialsClient({ connectionString: h.url('app') });
    await dead.close();
    const broken = build({ db: gbpDatabase(dead.pool) });
    await assert.rejects(broken.disconnect(ownerA));
    assert.equal(await count('external_provider_credentials'), 0, 'the credential step completed');
    assert.equal(await count('gbp_location_bindings', 'unbound_at is null'), 1, 'cleanup did not run');
    await rejectsWith(svc.bind(ownerA, 'locations/9002'), GbpConflictError, (e) => assert.equal((e as GbpConflictError).kind, 'not_connected'));
    await svc.disconnect(ownerA);
    assert.equal(await count('gbp_location_bindings', 'unbound_at is null'), 0);
    assert.equal(await count('gbp_location_candidates'), 0);
  });

  test('S/T: a credential persistence failure stores nothing and surfaces only a sanitized error', async () => {
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    const dead = createCredentialsClient({ connectionString: h.url('app') });
    await dead.close();
    const broken = build({ credentials: new ProviderCredentialService(dead.db, RING) });
    const error = await rejectsWith(broken.completeAuthorization(ownerA, { state, code }), CredentialStoreError);
    assert.ok(google.issued.every((v) => !inspect(error, { depth: 9 }).includes(v)), 'X: no token in the error');
    assert.equal(await count('external_provider_connections'), 0);
    assert.equal(await count('gbp_location_candidates'), 0);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, code }), OAuthAuthorizationInvalidError);
  });

  test('L/M/P: denial or a provider error consumes the state and stores nothing; missing code is refused', async () => {
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    await rejectsWith(svc.completeAuthorization(ownerA, { state }), GbpInvalidRequestError);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, code: 'x', error: 'access_denied' }), GbpInvalidRequestError);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, error: 'access_denied' }), GoogleAuthorizationDeniedError);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, error: 'access_denied' }), OAuthAuthorizationInvalidError, () => undefined);
    assert.equal(await count('external_provider_connections'), 0);
    assert.equal(google.requests.length, 0, 'no token exchange was attempted');
  });

  test('N/Q: a replayed or foreign code is rejected by Google (single-use, PKCE-bound) and nothing is stored', async () => {
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    await svc.completeAuthorization(ownerA, { state, code });
    const second = await svc.beginAuthorization(ownerA, REDIRECT);
    const secondState = new URL(second.authorizationUrl).searchParams.get('state')!;
    await rejectsWith(svc.completeAuthorization(ownerA, { state: secondState, code }), GoogleAuthorizationRejectedError);

    // A code issued for ANOTHER authorization (other PKCE challenge) cannot be completed under this one.
    const third = await svc.beginAuthorization(ownerA, REDIRECT);
    const fourth = await svc.beginAuthorization(ownerA, REDIRECT);
    const stolen = google.consent(third.authorizationUrl, clinicOwner());
    await rejectsWith(svc.completeAuthorization(ownerA, { state: new URL(fourth.authorizationUrl).searchParams.get('state')!, code: stolen.code }), GoogleAuthorizationRejectedError);
    assert.equal(await count('external_provider_credentials'), 1, 'only the first, legitimate completion stored a credential');
  });

  test('O: only exact allow-listed redirect URIs can begin an authorization', async () => {
    for (const uri of [`${REDIRECT}/`, `${REDIRECT}?x=1`, 'https://evil.example/callback', REDIRECT.toUpperCase()]) await rejectsWith(svc.beginAuthorization(ownerA, uri), GbpRedirectUriNotAllowedError);
    assert.equal(await count('provider_oauth_authorizations'), 0);
    await svc.beginAuthorization(ownerA, 'http://127.0.0.1:53682/callback');
  });

  test('R: malformed token responses, and a refused Business Profile scope, store nothing', async () => {
    for (const [edit, type] of [
      [(b: Record<string, unknown>) => ({ ...b, refresh_token: undefined }), GoogleResponseInvalidError],
      [(b: Record<string, unknown>) => ({ ...b, token_type: 'mac' }), GoogleResponseInvalidError],
      [(b: Record<string, unknown>) => ({ ...b, access_token: 'has space' }), GoogleResponseInvalidError],
      [(b: Record<string, unknown>) => ({ ...b, scope: 'openid email' }), GoogleScopeNotGrantedError],
    ] as const) {
      google.tokenResponseEdit = edit;
      await rejectsWith(connect(ownerA, clinicOwner()), type);
    }
    assert.equal(await count('external_provider_connections'), 0);
  });

  test('AJ/AK/AL/R: Google 5xx, 429, network failure and malformed discovery responses fail closed — nothing stored, errors classified, no detail leaked', async () => {
    const cases: [(url: string) => { status: number; body: unknown } | undefined, abstract new (...a: never[]) => Error, number][] = [
      [(u) => (u.includes('/v1/accounts?') ? { status: 503, body: { error: { message: 'backend secret detail' } } } : undefined), GoogleUnavailableError, 503],
      [(u) => (u.includes('/locations?') ? { status: 429, body: {} } : undefined), GoogleRateLimitedError, 503],
      [(u) => (u.includes('/v1/accounts?') ? { status: 200, body: { accounts: [{ name: 'accounts/../../x', type: 'PERSONAL' }] } } : undefined), GoogleResponseInvalidError, 502],
      [(u) => (u.includes('/locations?') ? { status: 200, body: { locations: [{ name: 'locations/1/../../reviews', title: 'x' }] } } : undefined), GoogleResponseInvalidError, 502],
      [(u) => (u.includes('/locations?') ? { status: 200, body: { locations: 'nope' } } : undefined), GoogleResponseInvalidError, 502],
      [(u) => (u.includes('/v1/accounts?') ? { status: 200, body: undefined } : undefined), GoogleResponseInvalidError, 502],
    ];
    for (const [override, type, httpStatus] of cases) {
      google.override = (r) => override(r.url);
      const error = await rejectsWith(connect(ownerA, clinicOwner()), type);
      assert.equal(classifyGbpError(error)?.httpStatus, httpStatus);
      assert.ok(!inspect(error, { depth: 9 }).includes('backend secret detail'));
    }
    google.override = undefined;
    const throwing = new GbpReadClient(async () => {
      throw new Error('ECONNRESET with Authorization: Bearer ya29.leaked');
    });
    const error = await rejectsWith(throwing.listAccounts('ya29.leaked'), GoogleUnavailableError);
    assert.ok(!inspect(error, { depth: 9 }).includes('ya29.leaked'));
    assert.equal(await count('external_provider_connections'), 0);
  });

  test('AM: provider metadata is untrusted display text — control/bidi characters stripped, length capped, never authority', async () => {
    const user = googleUser('111', { locations: { '111': [{ id: '9001', title: `<script>alert(1)</script>\u202e\u0000Clinic\nName${'x'.repeat(400)}`, address: { addressLines: ['\u2028line'], locality: 'Hyd' } }] } });
    const status = await connect(ownerA, user);
    const c = status.candidates[0]!;
    assert.ok(!/[\u0000-\u001f\u202e\u2028]/.test(c.title));
    assert.ok(c.title.length <= 200 && c.title.startsWith('<script>alert(1)</script> Clinic Name'), 'HTML is kept as inert text — the UI renders text, never markup');
    assert.equal(c.addressSummary, 'line, Hyd');
  });

  test('A–D/J/K: MEMBER, VIEWER and service principals are refused for every OWNER operation; OAuth state is bound to the same human and organization', async () => {
    const service = await serviceContext(ORG_A);
    for (const actor of [human(ORG_A, 'MEMBER'), human(ORG_A, 'VIEWER'), service]) {
      await rejectsWith(svc.status(actor), CredentialAccessDeniedError);
      await rejectsWith(svc.beginAuthorization(actor, REDIRECT), CredentialAccessDeniedError);
      await rejectsWith(svc.completeAuthorization(actor, { state: 'x'.repeat(43), code: 'c' }), CredentialAccessDeniedError);
      await rejectsWith(svc.bind(actor, 'locations/9001'), CredentialAccessDeniedError);
      await rejectsWith(svc.unbind(actor), CredentialAccessDeniedError);
      await rejectsWith(svc.disconnect(actor), CredentialAccessDeniedError);
    }
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    await rejectsWith(svc.completeAuthorization(ownerB, { state, code }), OAuthAuthorizationInvalidError);
    await rejectsWith(svc.completeAuthorization(human(ORG_A, 'OWNER', 'other-owner'), { state, code }), OAuthAuthorizationInvalidError);
    assert.equal(google.requests.length, 0, 'no code was exchanged for a mismatched human or organization');
    await svc.completeAuthorization(ownerA, { state, code });
  });

  test('AE: duplicate (concurrent) callbacks with one state — exactly one completes; concurrent first connections — exactly one open connection', async () => {
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    const dup = await Promise.allSettled([1, 2, 3].map(() => svc.completeAuthorization(ownerA, { state, code })));
    assert.equal(dup.filter((r) => r.status === 'fulfilled').length, 1);
    await svc.disconnect(ownerA);

    const user = clinicOwner();
    const starts = await Promise.all([1, 2, 3].map(() => svc.beginAuthorization(ownerA, REDIRECT)));
    const race = await Promise.allSettled(starts.map((s) => google.consent(s.authorizationUrl, user)).map(({ code: c, state: st }) => svc.completeAuthorization(ownerA, { state: st, code: c })));
    assert.ok(race.some((r) => r.status === 'fulfilled'));
    for (const r of race) if (r.status === 'rejected') assert.ok(r.reason instanceof GbpConflictError || r.reason instanceof CredentialStoreError, inspect(r.reason));
    assert.equal(await count('external_provider_connections', `provider = 'google_business_profile' and status <> 'DISCONNECTED'`), 1, 'G3 unique index: one open connection');
  });

  test('refresh (AF/AG/AH/AI): the service principal refreshes server-side on every use (no access token is stored); concurrent refreshes are independent; a revoked grant → NEEDS_REAUTH', async () => {
    const user = clinicOwner();
    const status = await connect(ownerA, user);
    const connectionId = status.connection!.connectionId;
    const service = await serviceContext(ORG_A);
    const results = await Promise.all([1, 2, 3].map(() => svc.validateConnection(service, connectionId)));
    assert.deepEqual(results, [{ accounts: 2 }, { accounts: 2 }, { accounts: 2 }]);
    assert.equal(google.requests.filter((r) => r.body?.includes('grant_type=refresh_token')).length, 3);
    await rejectsWith(svc.validateConnection(await serviceContext(ORG_B), connectionId), CredentialUnavailableError, () => undefined);
    await rejectsWith(svc.validateConnection(ownerA, connectionId), CredentialAccessDeniedError);

    google.revoke(user);
    await rejectsWith(svc.validateConnection(service, connectionId), ProviderCredentialRejectedError);
    assert.equal((await svc.status(ownerA)).connection?.status, 'NEEDS_REAUTH');
    await rejectsWith(svc.bind(ownerA, 'locations/9001'), GbpConflictError, (e) => assert.equal((e as GbpConflictError).kind, 'not_connected'));
    const healed = await connect(ownerA, user);
    assert.equal(healed.connection?.status, 'ACTIVE', 're-authorizing the same Google account heals it');
    assert.deepEqual(await svc.validateConnection(service, connectionId), { accounts: 2 });
  });

  test('RLS + grants: GBP tables are invisible without context and across organizations; the runtime role cannot delete or rewrite binding history or rewrite candidates', async () => {
    await connect(ownerA, clinicOwner());
    await connect(ownerB, agency());
    await svc.bind(ownerA, 'locations/9001');
    for (const table of ['gbp_location_candidates', 'gbp_location_bindings']) assert.equal((await h.app.pool.query(`select * from ${table}`)).rows.length, 0, `${table}: no context`);
    const client = await h.app.pool.connect();
    const inA = async (text: string) => {
      await client.query('BEGIN');
      await client.query(`select set_config('app.current_org_id', $1, true)`, [ORG_A]);
      try {
        return await client.query(text);
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      assert.equal((await inA(`select * from gbp_location_candidates where organization_id = '${ORG_B}'`)).rows.length, 0);
      for (const text of [
        `delete from gbp_location_bindings`,
        `update gbp_location_bindings set location_name = 'locations/1'`,
        `update gbp_location_bindings set organization_id = '${ORG_B}'`,
        `update gbp_location_candidates set title = 'x'`,
        `truncate gbp_location_candidates`,
      ]) {
        await assert.rejects(inA(text), (e: { code?: string }) => e.code === '42501', text);
      }
      await assert.rejects(
        inA(`insert into gbp_location_candidates (organization_id, connection_id, provider, location_name, account_name, account_display_name, title) values ('${ORG_B}', 'c', 'google_business_profile', 'locations/1', 'accounts/1', 'a', 't')`),
        (e: { code?: string }) => e.code === '42501',
      );
    } finally {
      client.release();
    }
  });
});
