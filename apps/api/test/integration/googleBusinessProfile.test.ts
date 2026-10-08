import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';

import { ACTIVE_KEY_VERSION_ENV, MASTER_KEYS_ENV, MasterKeyRing, ProviderCredentialService, ProviderOAuthAuthorizations } from '@samvardiq/platform-credentials';
import { GbpConnectionService, GbpReadClient, GoogleOAuthClient } from '@samvardiq/google-business-profile';

import { buildWorld, provisionMember, type TestWorld } from '../setup.js';
import { FakeGoogle, googleUser } from '../../../../packages/google-business-profile/test/fakeGoogle.js';
import { startHarness, type Harness } from '../../../../packages/google-business-profile/test/integration/harness.js';

/**
 * GBP-W1, the HTTP layer: real Fastify `.inject()` over the real Supabase-JWT
 * verification path, with the credential store and GBP tables on a real,
 * disposable PostgreSQL (runtime role) and an emulated Google. The service's
 * own guarantees are proven in packages/google-business-profile; this proves
 * the routes wire authentication, OWNER authority, input hygiene, response
 * minimization and log hygiene correctly.
 */
const ORG = 'org-gbp';
const BASE = `/v1/organizations/${ORG}/integrations/google-business-profile`;
const REDIRECT = 'https://app.example.test/integrations/google-business-profile/callback';

let h: Harness;
let google: FakeGoogle;
let world: TestWorld;
let logs = '';

function gbpService(): GbpConnectionService {
  const ring = MasterKeyRing.fromEnv({ [MASTER_KEYS_ENV]: `1:${randomBytes(32).toString('base64')}`, [ACTIVE_KEY_VERSION_ENV]: '1' });
  return new GbpConnectionService({
    db: h.appGbp,
    credentials: new ProviderCredentialService(h.app.db, ring),
    authorizations: new ProviderOAuthAuthorizations(h.app.db, ring),
    oauth: new GoogleOAuthClient({ clientId: google.clientId, clientSecret: google.clientSecret }, google.fetch),
    gbp: new GbpReadClient(google.fetch),
    redirectUris: [REDIRECT],
  });
}

before(async () => {
  h = await startHarness(55974);
});
after(async () => h.stop());

beforeEach(async () => {
  await h.truncateAll();
  google = new FakeGoogle();
  logs = '';
  const stream = new PassThrough();
  stream.on('data', (chunk) => (logs += chunk.toString()));
  world = await buildWorld({}, { loggerStream: stream }, { gbp: gbpService() });
  await provisionMember(world, { identityId: 'owner', subject: 'sub-owner', organizationId: ORG, role: 'OWNER' });
  for (const [identityId, role] of [['member', 'MEMBER'], ['viewer', 'VIEWER']] as const) {
    await world.identities.create({ identityId, principalType: 'human', displayName: identityId });
    await world.providerLinks.create({ identityId, provider: 'supabase', providerSubject: `sub-${identityId}` });
    await world.memberships.create({ organizationId: ORG, identityId, role, status: 'ACTIVE' });
  }
});

const auth = async (who: string) => ({ authorization: `Bearer ${await world.issuer.signToken({ sub: `sub-${who}` })}` });

async function begin(who = 'owner') {
  return world.app.inject({ method: 'POST', url: `${BASE}/authorizations`, headers: await auth(who), payload: { redirectUri: REDIRECT } });
}

test('E + full flow over HTTP: begin → consent → complete → bind → status → disconnect; only non-secret metadata is ever returned; nothing sensitive is logged', async () => {
  const started = await begin();
  assert.equal(started.statusCode, 201);
  const { authorizationUrl } = started.json() as { authorizationUrl: string };
  const { code, state } = google.consent(authorizationUrl, googleUser('111', { locations: { '111': [{ id: '9001', title: 'Clinic' }] } }));

  const completed = await world.app.inject({ method: 'POST', url: `${BASE}/authorizations/complete`, headers: await auth('owner'), payload: { state, code } });
  assert.equal(completed.statusCode, 200, completed.body);
  const status = completed.json() as { connection: { status: string; googleAccountId: string }; candidates: { locationName: string }[]; binding: null };
  assert.deepEqual({ s: status.connection.status, g: status.connection.googleAccountId, c: status.candidates.map((c) => c.locationName), b: status.binding }, { s: 'ACTIVE', g: 'accounts/111', c: ['locations/9001'], b: null });

  const bound = await world.app.inject({ method: 'POST', url: `${BASE}/binding`, headers: await auth('owner'), payload: { locationName: 'locations/9001' } });
  assert.equal(bound.statusCode, 200);
  assert.equal((bound.json() as { binding: { locationName: string } }).binding.locationName, 'locations/9001');

  const read = await world.app.inject({ method: 'GET', url: BASE, headers: await auth('owner') });
  assert.equal(read.statusCode, 200);

  const disconnected = await world.app.inject({ method: 'POST', url: `${BASE}/disconnect`, headers: await auth('owner') });
  assert.equal(disconnected.statusCode, 200);
  assert.deepEqual(disconnected.json(), { connection: null, binding: null, candidates: [], googleAuthorization: 'NOT_REVOKED' });

  const everything = [started.body, completed.body, bound.body, read.body, disconnected.body, logs].join('\n');
  for (const secret of [...google.issued, google.clientSecret]) assert.ok(!everything.includes(secret), 'V/W/X/Y: no token, code or client secret in any response or log line');
  // The state is SUPPOSED to reach the browser (inside the Google authorization URL); it must never be logged or echoed elsewhere.
  assert.ok(![completed.body, bound.body, read.body, disconnected.body, logs].join('\n').includes(state), 'the state is not logged or echoed');
  assert.ok(logs.length > 0, 'the request log was captured');
});

test('A: unauthenticated requests are 401 on every route', async () => {
  for (const [method, url, payload] of [
    ['GET', BASE, undefined],
    ['POST', `${BASE}/authorizations`, { redirectUri: REDIRECT }],
    ['POST', `${BASE}/authorizations/complete`, { state: 'x'.repeat(43), code: 'c' }],
    ['POST', `${BASE}/binding`, { locationName: 'locations/1' }],
    ['DELETE', `${BASE}/binding`, undefined],
    ['POST', `${BASE}/disconnect`, undefined],
  ] as const) {
    const res = await world.app.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

test('B/C: MEMBER and VIEWER are 403 "Access denied." — identical to a foreign organization', async () => {
  for (const who of ['member', 'viewer']) {
    const res = await begin(who);
    assert.deepEqual({ code: res.statusCode, body: res.json() }, { code: 403, body: { error: 'Access denied.' } });
  }
  const foreign = await world.app.inject({ method: 'GET', url: '/v1/organizations/someone-else/integrations/google-business-profile', headers: await auth('owner') });
  assert.deepEqual({ code: foreign.statusCode, body: foreign.json() }, { code: 403, body: { error: 'Access denied.' } });
});

test('AP: an OWNER whose membership is revoked between begin and complete is refused — the pending OAuth state confers nothing', async () => {
  const { authorizationUrl } = (await begin()).json() as { authorizationUrl: string };
  const { code, state } = google.consent(authorizationUrl, googleUser('111', { locations: {} }));
  await world.memberships.updateStatus(ORG, 'owner', 'REVOKED');
  const res = await world.app.inject({ method: 'POST', url: `${BASE}/authorizations/complete`, headers: await auth('owner'), payload: { state, code } });
  assert.equal(res.statusCode, 403);
  assert.equal(google.requests.length, 0, 'no code exchange happened');
});

test('input hygiene: bodies cannot name an organization or identity; malformed state/code/location are 400; denial is a clean 400', async () => {
  const headers = await auth('owner');
  const bad = [
    [`${BASE}/authorizations`, { redirectUri: REDIRECT, organizationId: 'other' }],
    [`${BASE}/authorizations/complete`, { state: 'x'.repeat(43), code: 'c', identityId: 'x' }],
    [`${BASE}/authorizations/complete`, { state: 'short', code: 'c' }],
    [`${BASE}/authorizations/complete`, { state: 'x'.repeat(43) }],
    [`${BASE}/authorizations/complete`, { state: 'x'.repeat(43), code: 'c', error: 'access_denied' }],
    [`${BASE}/authorizations/complete`, { state: 'x'.repeat(43), code: 'has space' }],
    [`${BASE}/binding`, { locationName: 'locations/1/../2' }],
  ] as const;
  for (const [url, payload] of bad) assert.equal((await world.app.inject({ method: 'POST', url, headers, payload })).statusCode, 400, JSON.stringify(payload));

  const { authorizationUrl } = (await begin()).json() as { authorizationUrl: string };
  const state = new URL(authorizationUrl).searchParams.get('state')!;
  const denied = await world.app.inject({ method: 'POST', url: `${BASE}/authorizations/complete`, headers, payload: { state, error: 'access_denied' } });
  assert.deepEqual({ code: denied.statusCode, body: denied.json() }, { code: 400, body: { error: 'Google authorization was not granted.' } });
  const notAllowed = await world.app.inject({ method: 'POST', url: `${BASE}/authorizations`, headers, payload: { redirectUri: 'https://evil.example/cb' } });
  assert.equal(notAllowed.statusCode, 400);
});

test('not configured: authenticated OWNER gets 503; unauthenticated still 401', async () => {
  const unconfigured = await buildWorld();
  await provisionMember(unconfigured, { identityId: 'owner', subject: 'sub-owner', organizationId: ORG, role: 'OWNER' });
  const token = await unconfigured.issuer.signToken({ sub: 'sub-owner' });
  const res = await unconfigured.app.inject({ method: 'GET', url: BASE, headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual({ code: res.statusCode, body: res.json() }, { code: 503, body: { error: 'Google Business Profile integration is not configured.' } });
  assert.equal((await unconfigured.app.inject({ method: 'GET', url: BASE })).statusCode, 401);
});
