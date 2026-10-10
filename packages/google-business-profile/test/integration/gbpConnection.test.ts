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
  GBP_SERVICE_PRINCIPAL_PROVIDER,
  GbpConflictError,
  GbpConnectionService,
  GbpInvalidRequestError,
  GbpLocationNotAvailableError,
  GbpReadClient,
  GbpRedirectUriNotAllowedError,
  GbpServicePrincipalUnavailableError,
  gbpDatabase,
  gbpServicePrincipalResolver,
  GoogleAccountMismatchError,
  GoogleAuthorizationDeniedError,
  GoogleAuthorizationRejectedError,
  GoogleOAuthClient,
  GoogleRateLimitedError,
  GoogleResponseInvalidError,
  GoogleScopeNotGrantedError,
  GoogleUnavailableError,
  type GbpLocation,
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

/** The operator-provisioned GBP service principals (ADR-IDENTITY-002 Candidate A), resolved through the unmodified AuthorizationService. */
async function principals(orgs: string[], status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  const identities = new InMemoryIdentityRepository();
  const links = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  for (const org of orgs) {
    const identityId = `svc-gbp-${org}`;
    await identities.create({ identityId, principalType: 'service', displayName: `GBP connector ${org}`, status: 'active' });
    await links.create({ identityId, provider: GBP_SERVICE_PRINCIPAL_PROVIDER, providerSubject: org });
    await memberships.create({ organizationId: org, identityId, role: 'MEMBER', status });
  }
  const authz = new AuthorizationService(identities, links, memberships);
  return { resolve: gbpServicePrincipalResolver(authz) };
}

/** Clinic owner's Google login: personal account 111 plus a location group 222. Location 9001 is also managed by the second user (agency). */
const clinicOwner = () =>
  googleUser('111', {
    groups: [{ id: '222', name: 'Clinic Group' }],
    locations: {
      '111': [{ id: '9001', title: 'Dr. Example Orthopaedic Clinic', address: { addressLines: ['1 Main Road'], locality: 'Hyderabad', postalCode: '500001' } }],
      '222': [{ id: '9002', title: 'Example Clinic — Branch' }, { id: '9004', title: 'Example Clinic — Second Branch' }, { id: '9001', title: 'Dr. Example Orthopaedic Clinic (dup)' }],
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

const conflict = (kind: string) => (e: Error) => assert.equal((e as GbpConflictError).kind, kind);
const bindAll = (svc: GbpConnectionService, actor: TrustedOrganizationContext, ...locationNames: string[]) => svc.bind(actor, { locationNames, confirm: true });

describe('GBP-W1 connection against real PostgreSQL', () => {
  let h: Harness;
  let google: FakeGoogle;
  let svc: GbpConnectionService;
  let credentials: ProviderCredentialService;
  let sp: Awaited<ReturnType<typeof principals>>;
  const ownerA = human(ORG_A, 'OWNER');
  const ownerB = human(ORG_B, 'OWNER');

  const build = (overrides: Partial<ConstructorParameters<typeof GbpConnectionService>[0]> = {}) =>
    new GbpConnectionService({
      db: h.appGbp,
      credentials,
      authorizations: new ProviderOAuthAuthorizations(h.app.db, RING),
      oauth: new GoogleOAuthClient({ clientId: google.clientId, clientSecret: google.clientSecret }, google.fetch),
      gbp: new GbpReadClient(google.fetch),
      servicePrincipal: sp.resolve,
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
    for (const table of ['provider_oauth_authorizations', 'external_provider_connections', 'external_provider_credentials', 'external_provider_credential_events', 'gbp_location_candidates', 'gbp_location_bindings', 'gbp_operation_events']) {
      const rows = (await h.owner.pool.query(`select * from ${table}`)).rows;
      parts.push(JSON.stringify(rows));
      for (const row of rows) for (const v of Object.values(row)) if (Buffer.isBuffer(v)) parts.push(v.toString('utf8'), v.toString('base64'), v.toString('hex'));
    }
    return parts.join('\n');
  }

  const count = async (table: string, where = 'true') => Number((await h.owner.pool.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0].n);
  const events = async () =>
    (await h.owner.pool.query(`select operation, phase, actor_principal_type as actor, actor_identity_id as identity, failure_class as failure, request_id from gbp_operation_events order by occurred_at, phase desc`)).rows;
  const revokes = () => google.requests.filter((r) => r.url === 'https://oauth2.googleapis.com/revoke').length;

  before(async () => {
    h = await startHarness(55973);
  });
  after(async () => h.stop());
  beforeEach(async () => {
    await h.truncateAll();
    google = new FakeGoogle();
    credentials = new ProviderCredentialService(h.app.db, RING);
    sp = await principals([ORG_A, ORG_B]);
    svc = build();
  });

  test('E: an OWNER connects — PKCE S256, offline access, consent; refresh token only as ARCH-020 ciphertext; first discovery runs as the service principal on the STORED credential; nothing is bound', async () => {
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
    assert.deepEqual(status.candidates.map((c) => c.locationName).sort(), ['locations/9001', 'locations/9002', 'locations/9004'], 'deduplicated across the accounts Google returned');
    assert.deepEqual(status.bindings, [], 'BB: a candidate is never an active binding');
    assert.equal(await count('external_provider_credentials'), 1);
    assert.equal(google.requests.filter((r) => r.body?.includes('grant_type=refresh_token')).length, 1, 'discovery used the stored refresh token');

    const audit = await events();
    assert.deepEqual(
      audit.map((e) => [e.operation, e.phase, e.actor, e.identity]),
      [
        ['GBP_DISCOVER_LOCATIONS', 'REQUESTED', 'human', ownerA.identityId],
        ['GBP_DISCOVER_LOCATIONS', 'SUCCEEDED', 'service', `svc-gbp-${ORG_A}`],
      ],
      'G1: the human request and the service execution are both audited, correlated, and distinct',
    );
    assert.equal(audit[0].request_id, audit[1].request_id);

    const db = await dump();
    for (const value of google.issued) assert.ok(!db.includes(value), 'V/W/AV: no token or code in any table (audit included), in any encoding');
    assert.ok(!db.includes(google.clientSecret));
    assert.ok(!db.includes(state), 'BM: the raw OAuth state is never stored');
    assert.ok(!JSON.stringify(status).match(/ya29\.|1\/\/0g|4\/0A/), 'AU: no token-shaped value in the OWNER-visible status');
  });

  test('BJ: read-only in practice — every business request is a GET to the two read endpoints; the only POSTs are the token endpoint and the OWNER-chosen revocation', async () => {
    await connect(ownerA, clinicOwner());
    await bindAll(svc, ownerA, 'locations/9001');
    await svc.refreshDiscovery(ownerA);
    await svc.verifyConnection(ownerA);
    await svc.disconnect(ownerA, { revokeGoogleAccess: true });
    for (const r of google.requests) {
      if (r.method === 'POST') assert.ok(['https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/revoke'].includes(r.url), r.url);
      else {
        assert.equal(r.method, 'GET');
        assert.match(r.url, /^https:\/\/(mybusinessaccountmanagement\.googleapis\.com\/v1\/accounts\?|mybusinessbusinessinformation\.googleapis\.com\/v1\/accounts\/[^/]+\/locations\?)/);
        assert.ok(!r.url.includes('ya29.') && !r.url.includes('1//0g'), 'tokens travel only in a header or form body, never in a URL');
      }
    }
    assert.equal(revokes(), 1);
  });

  test('AX: several locations are bound in one confirmed request; status lists each; stable resource names are the identity', async () => {
    await connect(ownerA, clinicOwner());
    const status = await bindAll(svc, ownerA, 'locations/9002', 'locations/9001', 'locations/9004');
    assert.deepEqual(
      status.bindings.map((b) => [b.locationName, b.accountName, b.boundByIdentityId, b.accessLostAt]).sort(),
      [
        ['locations/9001', 'accounts/111', ownerA.identityId, null],
        ['locations/9002', 'accounts/222', ownerA.identityId, null],
        ['locations/9004', 'accounts/222', ownerA.identityId, null],
      ],
    );
  });

  test('BP: nothing is bound without explicit confirmation and an explicit, valid, duplicate-free list', async () => {
    await connect(ownerA, clinicOwner());
    for (const input of [
      { locationNames: ['locations/9001'], confirm: false },
      { locationNames: ['locations/9001'] },
      { locationNames: [], confirm: true },
      { locationNames: ['locations/9001', 'locations/9001'], confirm: true },
      { locationNames: Array.from({ length: 26 }, (_, i) => `locations/${i}`), confirm: true },
      { locationNames: 'locations/9001', confirm: true },
    ]) {
      await rejectsWith(svc.bind(ownerA, input as never), GbpInvalidRequestError);
    }
    assert.equal(await count('gbp_location_bindings'), 0);
  });

  test('AB/AL: a location not returned for this connection, or a malformed name, cannot be bound — and a mixed request binds nothing', async () => {
    await connect(ownerA, clinicOwner());
    await rejectsWith(bindAll(svc, ownerA, 'locations/9003'), GbpLocationNotAvailableError);
    await rejectsWith(bindAll(svc, ownerA, 'locations/9001', 'locations/9003'), GbpLocationNotAvailableError);
    for (const bad of ['9001', 'locations/', 'locations/9001/reviews', "locations/1' or '1'='1", 'accounts/111']) await rejectsWith(bindAll(svc, ownerA, bad), GbpInvalidRequestError);
    assert.equal(await count('gbp_location_bindings'), 0);
  });

  test('AC/AD: another organization’s candidates are invisible — org A cannot bind a location only org B’s Google account returned', async () => {
    await connect(ownerA, clinicOwner());
    await connect(ownerB, agency());
    await rejectsWith(bindAll(svc, ownerA, 'locations/9003'), GbpLocationNotAvailableError);
    assert.deepEqual((await svc.status(ownerA)).candidates.map((c) => c.locationName).sort(), ['locations/9001', 'locations/9002', 'locations/9004']);
  });

  test('AN/AW: a location is actively bound to at most one organization (database-enforced, also under concurrency); after it is unbound, the other may bind', async () => {
    await connect(ownerA, clinicOwner());
    await connect(ownerB, agency());
    const race = await Promise.allSettled([bindAll(svc, ownerA, 'locations/9001'), bindAll(svc, ownerB, 'locations/9001')]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of race) if (r.status === 'rejected') assert.ok(r.reason instanceof GbpConflictError && r.reason.kind === 'bound_elsewhere', inspect(r.reason));
    const winner = (await svc.status(ownerA)).bindings.length ? ownerA : ownerB;
    const loser = winner === ownerA ? ownerB : ownerA;
    await rejectsWith(bindAll(svc, loser, 'locations/9001'), GbpConflictError, conflict('bound_elsewhere'));
    await svc.unbind(winner, 'locations/9001');
    assert.equal((await bindAll(svc, loser, 'locations/9001')).bindings[0]?.locationName, 'locations/9001');
    assert.equal(await count('gbp_location_bindings', `location_name = 'locations/9001' and unbound_at is null`), 1);
  });

  test('G3: re-binding an already bound location is refused; unbinding is per location and idempotent; history is kept', async () => {
    await connect(ownerA, clinicOwner());
    await bindAll(svc, ownerA, 'locations/9001', 'locations/9002');
    await rejectsWith(bindAll(svc, ownerA, 'locations/9002', 'locations/9004'), GbpConflictError, conflict('already_bound'));
    const after = await svc.unbind(ownerA, 'locations/9001');
    await svc.unbind(ownerA, 'locations/9001');
    assert.deepEqual(after.bindings.map((b) => b.locationName), ['locations/9002']);
    await bindAll(svc, ownerA, 'locations/9001');
    const history = (await h.owner.pool.query(`select location_name, unbind_reason from gbp_location_bindings order by bound_at, location_name`)).rows;
    assert.deepEqual(history, [
      { location_name: 'locations/9001', unbind_reason: 'OWNER_UNBOUND' },
      { location_name: 'locations/9002', unbind_reason: null },
      { location_name: 'locations/9001', unbind_reason: null },
    ]);
  });

  test('AZ/BA: same-account re-authorization keeps bindings once revalidated; a location Google stops returning fails closed (binding kept, marked) until it returns', async () => {
    const user = clinicOwner();
    const first = await connect(ownerA, user);
    await bindAll(svc, ownerA, 'locations/9002', 'locations/9001');
    const again = await connect(ownerA, user);
    assert.equal(again.connection?.connectionId, first.connection?.connectionId, 'same connection, re-authorized');
    assert.deepEqual(again.bindings.map((b) => [b.locationName, b.accessLostAt]).sort(), [['locations/9001', null], ['locations/9002', null]]);
    assert.equal(await count('external_provider_credentials'), 1, 'exactly one ciphertext after replacement');

    user.locations['accounts/222'] = [];
    const lost = await svc.refreshDiscovery(ownerA);
    assert.deepEqual(lost.candidates.map((c) => c.locationName), ['locations/9001']);
    const byName = Object.fromEntries(lost.bindings.map((b) => [b.locationName, b.accessLostAt]));
    assert.equal(byName['locations/9001'], null);
    assert.ok(byName['locations/9002'], 'the binding is kept but marked: not usable, not transferred');
    assert.equal(await count('gbp_location_bindings', "location_name = 'locations/9002' and unbound_at is null and organization_id = 'org-a'"), 1, 'still held by org A: never silently released to another organization');

    user.locations['accounts/222'] = [{ name: 'locations/9002', title: 'Example Clinic — Branch' }];
    const restored = await svc.refreshDiscovery(ownerA);
    assert.ok(restored.bindings.every((b) => b.accessLostAt === null), 'authorization restored → usable again');
  });

  test('AZ: a re-authorization whose revalidation fails leaves every binding marked unusable (fail closed)', async () => {
    const user = clinicOwner();
    await connect(ownerA, user);
    await bindAll(svc, ownerA, 'locations/9001');
    google.override = (r) => (r.url.includes('/locations?') ? { status: 503, body: {} } : undefined);
    await rejectsWith(connect(ownerA, user), GoogleUnavailableError);
    google.override = undefined;
    const status = await svc.status(ownerA);
    assert.equal(status.connection?.status, 'ACTIVE');
    assert.ok(status.bindings[0]?.accessLostAt, 'not usable until a discovery succeeds');
    assert.equal((await svc.refreshDiscovery(ownerA)).bindings[0]?.accessLostAt, null);
  });

  test('AY: a different Google account is refused until a controlled disconnect; nothing it returned is stored', async () => {
    await connect(ownerA, clinicOwner());
    await bindAll(svc, ownerA, 'locations/9001');
    const before = await dump();
    await rejectsWith(connect(ownerA, agency()), GoogleAccountMismatchError);
    assert.equal(await dump(), before, 'credential, candidates, bindings and audit unchanged; the state was consumed (row gone either way)');
    await svc.disconnect(ownerA, { revokeGoogleAccess: false });
    const fresh = await connect(ownerA, agency());
    assert.equal(fresh.connection?.googleAccountId, 'accounts/333');
  });

  test('BC/AO: local-only disconnect — DISCONNECTED, ciphertext deleted, every binding ended with history, candidates removed, Google not contacted; idempotent; no further use', async () => {
    await connect(ownerA, clinicOwner());
    await bindAll(svc, ownerA, 'locations/9001', 'locations/9002');
    const result = await svc.disconnect(ownerA, { revokeGoogleAccess: false });
    assert.equal(result.googleRevocation, 'NOT_REQUESTED');
    assert.deepEqual({ connection: result.connection, bindings: result.bindings, candidates: result.candidates }, { connection: null, bindings: [], candidates: [] });
    assert.equal(await count('external_provider_credentials'), 0);
    assert.equal(await count('gbp_location_bindings', `unbind_reason = 'CONNECTION_DISCONNECTED'`), 2);
    assert.equal(await count('gbp_location_candidates'), 0);
    assert.equal(revokes(), 0);
    await rejectsWith(svc.refreshDiscovery(ownerA), GbpConflictError, conflict('not_connected'));
    await rejectsWith(svc.verifyConnection(ownerA), GbpConflictError, conflict('not_connected'));
    assert.equal((await svc.disconnect(ownerA, { revokeGoogleAccess: true })).googleRevocation, 'NOT_REQUESTED', 'idempotent: nothing left to revoke');
    await rejectsWith(svc.disconnect(ownerA, {} as never), GbpInvalidRequestError);
  });

  test('disconnect with revocation: the service principal revokes at Google first (grant-wide), then the local disconnect; both audited', async () => {
    const user = clinicOwner();
    await connect(ownerA, user);
    const stored = google.issued.filter((t) => t.startsWith('1//0g'));
    const result = await svc.disconnect(ownerA, { revokeGoogleAccess: true });
    assert.equal(result.googleRevocation, 'REVOKED');
    assert.ok(stored.every((t) => !google.isLive(t)), 'Google no longer honours the grant');
    assert.equal(await count('external_provider_credentials'), 0);
    const revoke = (await events()).filter((e) => e.operation === 'GBP_REVOKE_CONNECTION');
    assert.deepEqual(revoke.map((e) => [e.phase, e.actor]), [['REQUESTED', 'human'], ['SUCCEEDED', 'service']]);
    const body = google.requests.find((r) => r.url.endsWith('/revoke'))!.body!;
    assert.ok(stored.some((t) => body.includes(encodeURIComponent(t))), 'the stored refresh token itself is what gets revoked');
  });

  test('BD: a revocation Google does not confirm is reported as FAILED (distinct audit outcome), never as success — and the local disconnect still happens', async () => {
    await connect(ownerA, clinicOwner());
    for (const reply of [{ status: 503, body: {} }, { status: 400, body: { error: 'invalid_token' } }]) {
      google.override = (r) => (r.url.endsWith('/revoke') ? reply : undefined);
      const result = await svc.disconnect(ownerA, { revokeGoogleAccess: true });
      assert.equal(result.googleRevocation, 'FAILED');
      assert.equal(result.connection, null);
      assert.equal(await count('external_provider_credentials'), 0);
      google.override = undefined;
      await connect(ownerA, clinicOwner());
    }
    const failed = (await events()).filter((e) => e.operation === 'GBP_REVOKE_CONNECTION' && e.phase === 'FAILED');
    assert.deepEqual(failed.map((e) => e.failure), ['gbp_revocation_failed', 'gbp_revocation_failed']);
    assert.equal(await count('gbp_operation_events', `operation = 'GBP_REVOKE_CONNECTION' and phase = 'SUCCEEDED'`), 0);
  });

  test('revocation is NOT_ATTEMPTED when no usable credential exists (NEEDS_REAUTH) or the service principal is suspended — the local disconnect still happens', async () => {
    const user = clinicOwner();
    await connect(ownerA, user);
    google.revoke(user);
    await rejectsWith(svc.verifyConnection(ownerA), ProviderCredentialRejectedError);
    assert.equal((await svc.disconnect(ownerA, { revokeGoogleAccess: true })).googleRevocation, 'NOT_ATTEMPTED');

    await connect(ownerA, clinicOwner());
    const suspended = await principals([ORG_A], 'SUSPENDED'); // the kill switch: the service membership is suspended
    const result = await build({ servicePrincipal: suspended.resolve }).disconnect(ownerA, { revokeGoogleAccess: true });
    assert.equal(result.googleRevocation, 'NOT_ATTEMPTED');
    assert.equal(result.connection, null);
    assert.equal(revokes(), 0);
  });

  test('U: a disconnect interrupted after the credential step converges when re-run', async () => {
    await connect(ownerA, clinicOwner());
    await bindAll(svc, ownerA, 'locations/9001');
    const dead = createCredentialsClient({ connectionString: h.url('app') });
    await dead.close();
    const broken = build({ db: gbpDatabase(dead.pool) });
    await assert.rejects(broken.disconnect(ownerA, { revokeGoogleAccess: false }));
    assert.equal(await count('external_provider_credentials'), 0, 'the credential step completed');
    assert.equal(await count('gbp_location_bindings', 'unbound_at is null'), 1, 'cleanup did not run');
    await rejectsWith(bindAll(svc, ownerA, 'locations/9002'), GbpConflictError, conflict('not_connected'));
    await svc.disconnect(ownerA, { revokeGoogleAccess: false });
    assert.equal(await count('gbp_location_bindings', 'unbound_at is null'), 0);
    assert.equal(await count('gbp_location_candidates'), 0);
  });

  test('S/T/U: a credential persistence failure stores nothing, surfaces only a sanitized error, burns the state, and is not auto-revoked (grant-wide)', async () => {
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    const dead = createCredentialsClient({ connectionString: h.url('app') });
    await dead.close();
    const broken = build({ credentials: new ProviderCredentialService(dead.db, RING) });
    const error = await rejectsWith(broken.completeAuthorization(ownerA, { state, code }), CredentialStoreError);
    assert.ok(google.issued.every((v) => !inspect(error, { depth: 9 }).includes(v)), 'X: no token in the error');
    assert.equal(await count('external_provider_connections'), 0);
    assert.equal(await count('gbp_location_candidates'), 0);
    assert.equal(revokes(), 0);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, code }), OAuthAuthorizationInvalidError);
    assert.equal((await connect(ownerA, clinicOwner())).connection?.status, 'ACTIVE', 'recovery: the OWNER simply starts again');
  });

  test('L/M/P: denial or a provider error consumes the state and stores nothing; missing code is refused', async () => {
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    await rejectsWith(svc.completeAuthorization(ownerA, { state }), GbpInvalidRequestError);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, code: 'x', error: 'access_denied' }), GbpInvalidRequestError);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, error: 'access_denied' }), GoogleAuthorizationDeniedError);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, error: 'access_denied' }), OAuthAuthorizationInvalidError);
    assert.equal(await count('external_provider_connections'), 0);
    assert.equal(google.requests.length, 0, 'no token exchange was attempted');
  });

  test('F/G/I: missing, altered or expired state is refused before any Google call', async () => {
    await rejectsWith(svc.completeAuthorization(ownerA, { state: '', code: 'c' }), OAuthAuthorizationInvalidError);
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const altered = (state[0] === 'A' ? 'B' : 'A') + state.slice(1);
    await rejectsWith(svc.completeAuthorization(ownerA, { state: altered, code: 'c' }), OAuthAuthorizationInvalidError);
    await h.owner.pool.query(`update provider_oauth_authorizations set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'`);
    await rejectsWith(svc.completeAuthorization(ownerA, { state, code: 'c' }), OAuthAuthorizationInvalidError);
    assert.equal(google.requests.length, 0);
  });

  test('N/Q: a replayed or foreign code is rejected by Google (single-use, PKCE-bound) and nothing is stored', async () => {
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    await svc.completeAuthorization(ownerA, { state, code });
    const second = await svc.beginAuthorization(ownerA, REDIRECT);
    await rejectsWith(svc.completeAuthorization(ownerA, { state: new URL(second.authorizationUrl).searchParams.get('state')!, code }), GoogleAuthorizationRejectedError);

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

  test('AJ/AK/AL/R: Google 5xx, 429, network failure and malformed responses fail closed — classified, no detail leaked; a failed service discovery is audited with its class', async () => {
    const cases: [(url: string) => { status: number; body: unknown } | undefined, abstract new (...a: never[]) => Error, number, string | null][] = [
      [(u) => (u.includes('/v1/accounts?') ? { status: 503, body: { error: { message: 'backend secret detail' } } } : undefined), GoogleUnavailableError, 503, null],
      [(u) => (u.includes('/v1/accounts?') ? { status: 200, body: { accounts: [{ name: 'accounts/../../x', type: 'PERSONAL' }] } } : undefined), GoogleResponseInvalidError, 502, null],
      [(u) => (u.includes('/v1/accounts?') ? { status: 200, body: undefined } : undefined), GoogleResponseInvalidError, 502, null],
      [(u) => (u.includes('/locations?') ? { status: 429, body: {} } : undefined), GoogleRateLimitedError, 503, 'google_rate_limited'],
      [(u) => (u.includes('/locations?') ? { status: 200, body: { locations: [{ name: 'locations/1/../../reviews', title: 'x' }] } } : undefined), GoogleResponseInvalidError, 502, 'google_response_invalid'],
      [(u) => (u.includes('/locations?') ? { status: 200, body: { locations: 'nope' } } : undefined), GoogleResponseInvalidError, 502, 'google_response_invalid'],
    ];
    for (const [override, type, httpStatus, failure] of cases) {
      await h.truncateAll();
      google.override = (r) => override(r.url);
      const error = await rejectsWith(connect(ownerA, clinicOwner()), type);
      assert.equal(classifyGbpError(error)?.httpStatus, httpStatus);
      assert.ok(!inspect(error, { depth: 9 }).includes('backend secret detail'));
      // Account identification happens before storing; location discovery runs as the service operation afterwards.
      assert.equal(await count('external_provider_connections'), failure ? 1 : 0);
      assert.equal(await count('gbp_location_candidates'), 0);
      if (failure) assert.deepEqual((await events()).map((e) => e.failure).filter(Boolean), [failure]);
    }
    google.override = undefined;
    const throwing = new GbpReadClient(async () => {
      throw new Error('ECONNRESET with Authorization: Bearer ya29.leaked');
    });
    const error = await rejectsWith(throwing.listAccounts('ya29.leaked'), GoogleUnavailableError);
    assert.ok(!inspect(error, { depth: 9 }).includes('ya29.leaked'));
  });

  test('AM: provider metadata is untrusted display text — control/bidi characters stripped, length capped, never authority', async () => {
    const user = googleUser('111', { locations: { '111': [{ id: '9001', title: `<script>alert(1)</script>\u202e\u0000Clinic\nName${'x'.repeat(400)}`, address: { addressLines: ['\u2028line'], locality: 'Hyd' } }] } });
    const status = await connect(ownerA, user);
    const c = status.candidates[0]!;
    assert.ok(!/[\u0000-\u001f\u202e\u2028]/.test(c.title));
    assert.ok(c.title.length <= 200 && c.title.startsWith('<script>alert(1)</script> Clinic Name'), 'HTML is kept as inert text — the UI renders text, never markup');
    assert.equal(c.addressSummary, 'line, Hyd');
  });

  test('A–D/J/K/AQ/BO/AP: MEMBER, VIEWER and service principals are refused for every OWNER operation; OAuth state is bound to the same human and organization; a demoted OWNER cannot complete', async () => {
    const service = await sp.resolve(ORG_A);
    for (const actor of [human(ORG_A, 'MEMBER'), human(ORG_A, 'VIEWER'), service]) {
      await rejectsWith(svc.status(actor), CredentialAccessDeniedError);
      await rejectsWith(svc.beginAuthorization(actor, REDIRECT), CredentialAccessDeniedError);
      await rejectsWith(svc.completeAuthorization(actor, { state: 'x'.repeat(43), code: 'c' }), CredentialAccessDeniedError);
      await rejectsWith(bindAll(svc, actor, 'locations/9001'), CredentialAccessDeniedError);
      await rejectsWith(svc.unbind(actor, 'locations/9001'), CredentialAccessDeniedError);
      await rejectsWith(svc.refreshDiscovery(actor), CredentialAccessDeniedError);
      await rejectsWith(svc.verifyConnection(actor), CredentialAccessDeniedError);
      await rejectsWith(svc.disconnect(actor, { revokeGoogleAccess: true }), CredentialAccessDeniedError);
    }
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    await rejectsWith(svc.completeAuthorization(ownerB, { state, code }), OAuthAuthorizationInvalidError);
    await rejectsWith(svc.completeAuthorization(human(ORG_A, 'OWNER', 'other-owner'), { state, code }), OAuthAuthorizationInvalidError);
    // The initiating OWNER's role was changed (or membership revoked → the request boundary refuses before this) during OAuth.
    await rejectsWith(svc.completeAuthorization(human(ORG_A, 'MEMBER', ownerA.identityId), { state, code }), CredentialAccessDeniedError);
    assert.equal(google.requests.length, 0, 'no code was exchanged for a mismatched human, organization or role');
    await svc.completeAuthorization(ownerA, { state, code });
  });

  test('G1 service authority: unprovisioned or suspended principals refuse before Google; a resolver yielding another organization or a human is refused (AR/confused deputy); humans cannot use credentials directly (AT)', async () => {
    const none = build({ servicePrincipal: (await principals([ORG_B])).resolve });
    await rejectsWith(none.beginAuthorization(ownerA, REDIRECT), GbpServicePrincipalUnavailableError);
    assert.equal(await count('provider_oauth_authorizations'), 0, 'refused before any state is created');

    const pending = await svc.beginAuthorization(ownerA, REDIRECT);
    const consent = google.consent(pending.authorizationUrl, clinicOwner());
    await rejectsWith(none.completeAuthorization(ownerA, { state: consent.state, code: consent.code }), GbpServicePrincipalUnavailableError);
    assert.equal(google.requests.length, 0, 'suspended between begin and complete: the code is never exchanged, nothing stored');
    assert.equal(await count('external_provider_connections'), 0);

    const status = await svc.completeAuthorization(ownerA, { state: consent.state, code: consent.code });
    const connectionId = status.connection!.connectionId;
    const before = google.requests.length;
    await rejectsWith(none.refreshDiscovery(ownerA), GbpServicePrincipalUnavailableError);
    assert.deepEqual((await events()).slice(-1).map((e) => [e.operation, e.phase, e.actor]), [['GBP_DISCOVER_LOCATIONS', 'REQUESTED', 'human']], 'the request is audited; there is no service outcome');

    const orgB = (await principals([ORG_B])).resolve;
    const deputy = build({ servicePrincipal: () => orgB(ORG_B) });
    await rejectsWith(deputy.refreshDiscovery(ownerA), GbpServicePrincipalUnavailableError);
    const impersonating = build({ servicePrincipal: async () => ownerA });
    await rejectsWith(impersonating.verifyConnection(ownerA), GbpServicePrincipalUnavailableError);
    assert.equal(google.requests.length, before, 'no Google call for any refused principal');

    await rejectsWith(credentials.useCredential(ownerA, connectionId, 'oauth_refresh_token', async () => 'x'), CredentialAccessDeniedError);
    await rejectsWith(credentials.useCredential(await sp.resolve(ORG_B), connectionId, 'oauth_refresh_token', async () => 'x'), CredentialUnavailableError);
  });

  test('AS: only the three allow-listed operations can ever be audited as executed (database CHECK); the service exposes no generic execute', async () => {
    const status = await connect(ownerA, clinicOwner());
    await assert.rejects(
      h.owner.pool.query(
        `insert into gbp_operation_events (organization_id, event_id, request_id, connection_id, provider, operation, phase, actor_principal_type, actor_identity_id)
         values ($1, 'e', 'r', $2, 'google_business_profile', 'GBP_UPDATE_PROFILE', 'REQUESTED', 'human', 'x')`,
        [ORG_A, status.connection!.connectionId],
      ),
      (e: { code?: string }) => e.code === '23514',
    );
    assert.ok(!Object.getOwnPropertyNames(GbpConnectionService.prototype).some((m) => /execute|proxy|request/i.test(m)));
  });

  test('verify: HEALTHY while Google accepts the grant; a revoked grant → NEEDS_REAUTH (audited failure); same-account reconnect heals', async () => {
    const user = clinicOwner();
    await connect(ownerA, user);
    const ok = await svc.verifyConnection(ownerA);
    assert.equal(ok.health, 'HEALTHY');
    assert.equal(ok.connection?.status, 'ACTIVE');

    google.revoke(user);
    const error = await rejectsWith(svc.verifyConnection(ownerA), ProviderCredentialRejectedError);
    assert.equal(classifyGbpError(error)?.httpStatus, 409);
    assert.equal((await svc.status(ownerA)).connection?.status, 'NEEDS_REAUTH');
    assert.equal((await events()).at(-1)?.failure, 'credential_rejected');
    await rejectsWith(svc.refreshDiscovery(ownerA), GbpConflictError, conflict('not_connected'));
    await rejectsWith(bindAll(svc, ownerA, 'locations/9001'), GbpConflictError, conflict('not_connected'));
    const healed = await connect(ownerA, user);
    assert.equal(healed.connection?.status, 'ACTIVE', 're-authorizing the same Google account heals it');
    assert.equal((await svc.verifyConnection(ownerA)).health, 'HEALTHY');
  });

  test('AF/AH/BF: concurrent refreshes against a provider that rotates refresh tokens leave exactly one, current credential — never an older value', async () => {
    await connect(ownerA, clinicOwner());
    google.rotateRefreshTokens = true;
    const results = await Promise.allSettled([1, 2, 3].map(() => svc.verifyConnection(ownerA)));
    assert.ok(results.some((r) => r.status === 'fulfilled'));
    assert.equal(await count('external_provider_credentials'), 1);
    assert.equal((await svc.status(ownerA)).connection?.status, 'ACTIVE');
    assert.equal((await svc.verifyConnection(ownerA)).health, 'HEALTHY', 'the stored token is the live, latest one');
    assert.ok(Number(await count('external_provider_credential_events', `event_type = 'CREDENTIAL_REPLACED' and actor_principal_type = 'service'`)) >= 2);
  });

  test('AO/BN: a disconnect racing an in-flight discovery wins — nothing is written for the disconnected connection and it is never revived', async () => {
    await connect(ownerA, clinicOwner());
    await bindAll(svc, ownerA, 'locations/9001');
    class DisconnectingClient extends GbpReadClient {
      override async listLocations(accessToken: string, account: Parameters<GbpReadClient['listLocations']>[1]): Promise<GbpLocation[]> {
        const found = await super.listLocations(accessToken, account);
        await svc.disconnect(ownerA, { revokeGoogleAccess: false });
        return found;
      }
    }
    await rejectsWith(build({ gbp: new DisconnectingClient(google.fetch) }).refreshDiscovery(ownerA), GbpConflictError, conflict('not_connected'));
    assert.equal(await count('gbp_location_candidates'), 0);
    assert.equal(await count('external_provider_connections', `status = 'DISCONNECTED'`), 1);
    assert.equal(await count('gbp_location_bindings', 'unbound_at is null'), 0);
  });

  test('AE/BE: duplicate (concurrent) callbacks with one state — exactly one completes; concurrent first connections — exactly one open connection', async () => {
    const { authorizationUrl } = await svc.beginAuthorization(ownerA, REDIRECT);
    const { code, state } = google.consent(authorizationUrl, clinicOwner());
    const dup = await Promise.allSettled([1, 2, 3].map(() => svc.completeAuthorization(ownerA, { state, code })));
    assert.equal(dup.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await count('external_provider_credentials'), 1);
    await svc.disconnect(ownerA, { revokeGoogleAccess: false });

    const user = clinicOwner();
    const starts = await Promise.all([1, 2, 3].map(() => svc.beginAuthorization(ownerA, REDIRECT)));
    const race = await Promise.allSettled(starts.map((s) => google.consent(s.authorizationUrl, user)).map(({ code: c, state: st }) => svc.completeAuthorization(ownerA, { state: st, code: c })));
    assert.ok(race.some((r) => r.status === 'fulfilled'));
    for (const r of race) if (r.status === 'rejected') assert.ok(r.reason instanceof GbpConflictError || r.reason instanceof CredentialStoreError, inspect(r.reason));
    assert.equal(await count('external_provider_connections', `provider = 'google_business_profile' and status <> 'DISCONNECTED'`), 1, 'G3 unique index: one open connection');
  });

  test('RLS + grants: GBP tables are invisible without context and across organizations; history and audit cannot be deleted or rewritten (audit immutable even for the owner)', async () => {
    await connect(ownerA, clinicOwner());
    await connect(ownerB, agency());
    await bindAll(svc, ownerA, 'locations/9001');
    for (const table of ['gbp_location_candidates', 'gbp_location_bindings', 'gbp_operation_events']) assert.equal((await h.app.pool.query(`select * from ${table}`)).rows.length, 0, `${table}: no context`);
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
      for (const table of ['gbp_location_candidates', 'gbp_operation_events']) assert.equal((await inA(`select * from ${table} where organization_id = '${ORG_B}'`)).rows.length, 0);
      for (const text of [
        `delete from gbp_location_bindings`,
        `update gbp_location_bindings set location_name = 'locations/1'`,
        `update gbp_location_bindings set organization_id = '${ORG_B}'`,
        `update gbp_location_candidates set title = 'x'`,
        `truncate gbp_location_candidates`,
        `update gbp_operation_events set phase = 'SUCCEEDED'`,
        `delete from gbp_operation_events`,
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
    await assert.rejects(h.owner.pool.query(`update gbp_operation_events set failure_class = 'x'`), /immutable/);
    await assert.rejects(h.owner.pool.query(`delete from gbp_operation_events`), /immutable/);
  });
});
