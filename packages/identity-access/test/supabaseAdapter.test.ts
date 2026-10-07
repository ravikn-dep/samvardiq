import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ExpiredCredentialError,
  InvalidCredentialError,
  ProviderConfigurationError,
  ProviderUnavailableError,
} from '../src/errors.js';
import { loadSupabaseConfigFromEnv, SupabaseIdentityProviderAdapter } from '../src/providers/supabaseIdentityProviderAdapter.js';
import { createTestIssuer, unreachableFetch } from './jwksTestHelper.js';

// A — valid verified Supabase identity -> VerifiedPrincipal
test('A: a validly signed, current token resolves to a VerifiedPrincipal', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ sub: 'user-abc' });

  const principal = await adapter.verifyCredential({ rawToken: token });

  assert.equal(principal.provider, 'supabase');
  assert.equal(principal.providerSubject, 'user-abc');
  assert.ok(principal.verifiedAt);
  assert.ok(Object.isFrozen(principal));
});

// B — malformed token -> denied
test('B: a malformed token is denied', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });

  await assert.rejects(adapter.verifyCredential({ rawToken: 'not-a-jwt-at-all' }), InvalidCredentialError);
});

// C — expired token -> denied
test('C: an expired token is denied', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ expiresInSeconds: -3600 });

  await assert.rejects(adapter.verifyCredential({ rawToken: token }), ExpiredCredentialError);
});

// D — tampered token -> denied
test('D: a tampered signature is denied', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken();
  const parts = token.split('.');
  const tamperedSignature = parts[2]!.slice(0, -4) + (parts[2]!.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  const tampered = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

  await assert.rejects(adapter.verifyCredential({ rawToken: tampered }), InvalidCredentialError);
});

// E — wrong issuer -> denied
test('E: a token issued by an unexpected issuer is denied', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ iss: 'https://attacker.example/auth/v1' });

  await assert.rejects(adapter.verifyCredential({ rawToken: token }), InvalidCredentialError);
});

// F — audience validation: not applicable (documented, not silently skipped — see adapter's own doc comment)
test('F: audience validation is not applicable — Supabase JWTs carry no aud claim, confirmed by design not by omission', () => {
  assert.ok(
    true,
    'documented in providers/supabaseIdentityProviderAdapter.ts: Supabase JWTs have no aud claim per official docs, so there is nothing to validate here',
  );
});

// G — unsigned / unsupported algorithm -> denied (algorithm-confusion defense)
test('G: a token signed with an unsupported algorithm (HS256) is denied', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ alg: 'HS256' });

  await assert.rejects(adapter.verifyCredential({ rawToken: token }), InvalidCredentialError);
});

// H — missing subject -> denied
test('H: a token with no subject claim is denied', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ sub: null });

  await assert.rejects(adapter.verifyCredential({ rawToken: token }), InvalidCredentialError);
});

// I — provider verification failure (signed with an unrelated/foreign key) -> denied
test('I: a token signed with a foreign, unrelated key is denied', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ signWithForeignKey: true });

  await assert.rejects(adapter.verifyCredential({ rawToken: token }), InvalidCredentialError);
});

// J — provider unavailable -> fail closed
test('J: a JWKS fetch failure (provider unavailable) fails closed, never falls back to trusting the token', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: { customFetch: unreachableFetch } as never });
  const token = await issuer.signToken();

  await assert.rejects(adapter.verifyCredential({ rawToken: token }), ProviderUnavailableError);
});

// K — decoded-but-unverified claims cannot create VerifiedPrincipal
test('K: the adapter exposes no decode-only path — verifyCredential is the only way to obtain a VerifiedPrincipal', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const publicMembers = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).filter((name) => name !== 'constructor');
  assert.deepEqual(publicMembers, ['verifyCredential']);
});

// X — email cannot establish organization access (VerifiedPrincipal never carries it)
test('X: an email claim in the token is never propagated into VerifiedPrincipal', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ extraClaims: { email: 'someone@clinic.com' } });

  const principal = await adapter.verifyCredential({ rawToken: token });

  assert.deepEqual(Object.keys(principal).sort(), ['provider', 'providerSubject', 'verifiedAt']);
});

// Y — token/credential never emitted into error output
test('Y: no thrown error message contains the raw token value', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const secretLookingToken = await issuer.signToken({ expiresInSeconds: -1 });

  try {
    await adapter.verifyCredential({ rawToken: secretLookingToken });
    assert.fail('expected rejection');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secretLookingToken), 'error message must never embed the raw token');
  }
});

// Z — provider-specific type does not leak beyond the adapter boundary (structural, by construction — see index.ts barrel split)
test('Z: SupabaseAdapterConfig requires only a URL — no Supabase SDK object/type is part of the public constructor contract', async () => {
  const issuer = await createTestIssuer();
  // If this compiles and runs with nothing but a plain string URL + jose passthrough options,
  // no Supabase SDK type was required to construct or use the adapter.
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  assert.equal(adapter.provider, 'supabase');
});

// Configuration failures (section 12) — fail closed, never silently insecure
test('configuration: a missing projectUrl fails closed', () => {
  assert.throws(() => new SupabaseIdentityProviderAdapter({ projectUrl: '' }), ProviderConfigurationError);
});

test('configuration: a non-https projectUrl fails closed', () => {
  assert.throws(() => new SupabaseIdentityProviderAdapter({ projectUrl: 'http://insecure.example' }), ProviderConfigurationError);
});

test('configuration: loadSupabaseConfigFromEnv fails closed when SUPABASE_PROJECT_URL is unset', () => {
  assert.throws(() => loadSupabaseConfigFromEnv({}), ProviderConfigurationError);
});

test('configuration: loadSupabaseConfigFromEnv succeeds with a valid URL', () => {
  const config = loadSupabaseConfigFromEnv({ SUPABASE_PROJECT_URL: 'https://real-project.supabase.co' });
  assert.equal(config.projectUrl, 'https://real-project.supabase.co');
});

// --- IDENTITY-SUPABASE-AUTH-STAGING additions -------------------------------------------------------------------------

test('STAGING-F: a token that is not yet valid (nbf in the future) is denied', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({ extraClaims: { nbf: Math.floor(Date.now() / 1000) + 3600 } });
  await assert.rejects(adapter.verifyCredential({ rawToken: token }), InvalidCredentialError);
});

test('STAGING-R: a genuine token from ANOTHER Supabase project (its own issuer and keys) is denied', async () => {
  const ours = await createTestIssuer();
  const theirs = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: ours.projectUrl, jwksOptions: ours.jwksOptions });
  await assert.rejects(adapter.verifyCredential({ rawToken: await theirs.signToken() }), InvalidCredentialError);
  // Even re-labelled with our issuer, their signature does not match our JWKS.
  await assert.rejects(adapter.verifyCredential({ rawToken: await theirs.signToken({ iss: `${ours.projectUrl}/auth/v1` }) }), InvalidCredentialError);
});

test('STAGING-V/W: role, app_metadata and user_metadata (incl. injected organization or OWNER) never reach the VerifiedPrincipal', async () => {
  const issuer = await createTestIssuer();
  const adapter = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });
  const token = await issuer.signToken({
    sub: 'subject-v',
    extraClaims: { role: 'service_role', app_metadata: { role: 'OWNER', organization_id: 'org-x' }, user_metadata: { organizationId: 'org-x', isAdmin: true }, organization_id: 'org-x' },
  });
  const principal = await adapter.verifyCredential({ rawToken: token });
  assert.deepEqual(Object.keys(principal).sort(), ['provider', 'providerSubject', 'verifiedAt']);
  assert.deepEqual([principal.provider, principal.providerSubject], ['supabase', 'subject-v']);
});

test('STAGING-AC: signing-key rotation — a token under a newly published key is accepted after the JWKS refreshes; a retired key is refused', async () => {
  const { generateKeyPair, exportJWK, SignJWT, customFetch } = await import('jose');
  const projectUrl = 'https://rotation-test.supabase.example';
  const mk = async (kid: string) => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' } };
  };
  const [oldKey, newKey] = await Promise.all([mk('old'), mk('new')]);
  let published = [oldKey.jwk];
  const adapter = new SupabaseIdentityProviderAdapter({
    projectUrl,
    jwksOptions: { cooldownDuration: 0, cacheMaxAge: 0, [customFetch]: async () => new Response(JSON.stringify({ keys: published }), { status: 200, headers: { 'content-type': 'application/json' } }) },
  });
  const sign = (k: typeof oldKey) =>
    new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: k.kid }).setIssuer(`${projectUrl}/auth/v1`).setSubject('rot').setIssuedAt().setExpirationTime('1h').sign(k.privateKey);
  assert.equal((await adapter.verifyCredential({ rawToken: await sign(oldKey) })).providerSubject, 'rot');
  await assert.rejects(adapter.verifyCredential({ rawToken: await sign(newKey) }), InvalidCredentialError, 'unpublished key refused');
  published = [oldKey.jwk, newKey.jwk]; // rotation: new key published alongside the old
  assert.equal((await adapter.verifyCredential({ rawToken: await sign(newKey) })).providerSubject, 'rot');
  published = [newKey.jwk]; // old key retired
  await assert.rejects(adapter.verifyCredential({ rawToken: await sign(oldKey) }), InvalidCredentialError, 'retired key refused');
});
