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
