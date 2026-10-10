import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';

import { ACTIVE_KEY_VERSION_ENV, MASTER_KEYS_ENV, MasterKeyRing, ProviderCredentialService, ProviderOAuthAuthorizations } from '@samvardiq/platform-credentials';
import { GBP_SERVICE_PRINCIPAL_PROVIDER, GbpConnectionService, GbpReadClient, gbpServicePrincipalResolver, GoogleOAuthClient } from '@samvardiq/google-business-profile';

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
    // The world's own AuthorizationService, as in the composition root (resolved lazily: the world is built with this service).
    servicePrincipal: (organizationId) => gbpServicePrincipalResolver(world.authz)(organizationId),
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
  // The operator-provisioned GBP service principal (ADR-IDENTITY-002), as provisionGbpServicePrincipal.ts creates it.
  await world.identities.create({ identityId: `svc-gbp-${ORG}`, principalType: 'service', displayName: 'GBP connector' });
  await world.providerLinks.create({ identityId: `svc-gbp-${ORG}`, provider: GBP_SERVICE_PRINCIPAL_PROVIDER, providerSubject: ORG });
  await world.memberships.create({ organizationId: ORG, identityId: `svc-gbp-${ORG}`, role: 'MEMBER', status: 'ACTIVE' });
});

const auth = async (who: string) => ({ authorization: `Bearer ${await world.issuer.signToken({ sub: `sub-${who}` })}` });

async function begin(who = 'owner') {
  return world.app.inject({ method: 'POST', url: `${BASE}/authorizations`, headers: await auth(who), payload: { redirectUri: REDIRECT } });
}

test('E + full flow over HTTP: begin → consent → complete → bind several → discovery → verify → unbind → disconnect+revoke; only non-secret metadata returned; nothing sensitive logged', async () => {
  const started = await begin();
  assert.equal(started.statusCode, 201);
  const { authorizationUrl } = started.json() as { authorizationUrl: string };
  const user = googleUser('111', { locations: { '111': [{ id: '9001', title: 'Clinic' }, { id: '9002', title: 'Branch' }] } });
  const { code, state } = google.consent(authorizationUrl, user);
  const headers = await auth('owner');

  const completed = await world.app.inject({ method: 'POST', url: `${BASE}/authorizations/complete`, headers, payload: { state, code } });
  assert.equal(completed.statusCode, 200, completed.body);
  const status = completed.json() as { connection: { status: string; googleAccountId: string }; candidates: { locationName: string }[]; bindings: unknown[] };
  assert.deepEqual(
    { s: status.connection.status, g: status.connection.googleAccountId, c: status.candidates.map((c) => c.locationName).sort(), b: status.bindings },
    { s: 'ACTIVE', g: 'accounts/111', c: ['locations/9001', 'locations/9002'], b: [] },
  );

  const unconfirmed = await world.app.inject({ method: 'POST', url: `${BASE}/bindings`, headers, payload: { locationNames: ['locations/9001'], confirm: false } });
  assert.equal(unconfirmed.statusCode, 400, 'BP: confirmation is mandatory');
  const bound = await world.app.inject({ method: 'POST', url: `${BASE}/bindings`, headers, payload: { locationNames: ['locations/9001', 'locations/9002'], confirm: true } });
  assert.equal(bound.statusCode, 200, bound.body);
  assert.deepEqual((bound.json() as { bindings: { locationName: string }[] }).bindings.map((b) => b.locationName).sort(), ['locations/9001', 'locations/9002']);

  const discovery = await world.app.inject({ method: 'POST', url: `${BASE}/discovery`, headers });
  assert.equal(discovery.statusCode, 200, discovery.body);
  const verified = await world.app.inject({ method: 'POST', url: `${BASE}/verify`, headers });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal((verified.json() as { health: string }).health, 'HEALTHY');

  const unbound = await world.app.inject({ method: 'DELETE', url: `${BASE}/bindings/9002`, headers });
  assert.deepEqual((unbound.json() as { bindings: { locationName: string }[] }).bindings.map((b) => b.locationName), ['locations/9001']);

  const read = await world.app.inject({ method: 'GET', url: BASE, headers });
  assert.equal(read.statusCode, 200);

  const disconnected = await world.app.inject({ method: 'POST', url: `${BASE}/disconnect`, headers, payload: { revokeGoogleAccess: true } });
  assert.equal(disconnected.statusCode, 200);
  assert.deepEqual(disconnected.json(), { connection: null, bindings: [], candidates: [], googleRevocation: 'REVOKED' });

  const afterStart = [completed.body, bound.body, discovery.body, verified.body, unbound.body, read.body, disconnected.body, logs].join('\n');
  for (const secret of [...google.issued, google.clientSecret]) assert.ok(![started.body, afterStart].join('\n').includes(secret), 'V/W/X/Y/AU: no token, code or client secret in any response or log line');
  // The state is SUPPOSED to reach the browser (inside the Google authorization URL); it must never be logged or echoed elsewhere.
  assert.ok(!afterStart.includes(state), 'BM: the state is not logged or echoed');
  assert.ok(logs.length > 0, 'the request log was captured');
});

test('G1 kill switch: with the GBP service principal suspended, provider operations are 503 and Google is not called', async () => {
  const { authorizationUrl } = (await begin()).json() as { authorizationUrl: string };
  const { code, state } = google.consent(authorizationUrl, googleUser('111', { locations: {} }));
  const headers = await auth('owner');
  assert.equal((await world.app.inject({ method: 'POST', url: `${BASE}/authorizations/complete`, headers, payload: { state, code } })).statusCode, 200);
  await world.memberships.updateStatus(ORG, `svc-gbp-${ORG}`, 'SUSPENDED');
  const calls = google.requests.length;
  for (const url of [`${BASE}/discovery`, `${BASE}/verify`]) {
    const res = await world.app.inject({ method: 'POST', url, headers });
    assert.deepEqual({ code: res.statusCode, body: res.json() }, { code: 503, body: { error: 'Google Business Profile operations are not enabled for this organization.' } });
  }
  assert.equal((await begin()).statusCode, 503, 'no new authorization either');
  assert.equal(google.requests.length, calls);
});

test('A: unauthenticated requests are 401 on every route', async () => {
  for (const [method, url, payload] of [
    ['GET', BASE, undefined],
    ['POST', `${BASE}/authorizations`, { redirectUri: REDIRECT }],
    ['POST', `${BASE}/authorizations/complete`, { state: 'x'.repeat(43), code: 'c' }],
    ['POST', `${BASE}/bindings`, { locationNames: ['locations/1'], confirm: true }],
    ['DELETE', `${BASE}/bindings/1`, undefined],
    ['POST', `${BASE}/discovery`, undefined],
    ['POST', `${BASE}/verify`, undefined],
    ['POST', `${BASE}/disconnect`, { revokeGoogleAccess: false }],
  ] as const) {
    const res = await world.app.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

test('B/C/AA: MEMBER and VIEWER are 403 "Access denied." on every operation — identical to a foreign organization', async () => {
  for (const who of ['member', 'viewer']) {
    const res = await begin(who);
    assert.deepEqual({ code: res.statusCode, body: res.json() }, { code: 403, body: { error: 'Access denied.' } });
    for (const [method, url, payload] of [
      ['GET', BASE, undefined],
      ['POST', `${BASE}/discovery`, undefined],
      ['POST', `${BASE}/verify`, undefined],
      ['POST', `${BASE}/bindings`, { locationNames: ['locations/1'], confirm: true }],
      ['DELETE', `${BASE}/bindings/1`, undefined],
      ['POST', `${BASE}/disconnect`, { revokeGoogleAccess: true }],
    ] as const) {
      const r = await world.app.inject({ method, url, headers: await auth(who), ...(payload ? { payload } : {}) });
      assert.equal(r.statusCode, 403, `${who} ${method} ${url}`);
    }
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
    [`${BASE}/bindings`, { locationNames: ['locations/1/../2'], confirm: true }],
    [`${BASE}/bindings`, { locationNames: ['locations/1'], confirm: true, organizationId: 'other' }],
    [`${BASE}/bindings`, { locationNames: ['locations/1', 'locations/1'], confirm: true }],
    [`${BASE}/disconnect`, {}],
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
