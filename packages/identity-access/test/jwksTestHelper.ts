import { customFetch, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type RemoteJWKSetOptions } from 'jose';

/**
 * CRYPTOGRAPHIC VERIFICATION TEST support (not a mock, not a real-provider
 * integration test — see the session report's "Real Provider Testing
 * Strategy" for the three-way distinction). Generates a real, disposable
 * ES256 keypair and signs real JWTs with it; the adapter under test
 * performs genuine `jose` signature/issuer/expiration verification
 * against a real JWKS document built from the real public key. The only
 * thing faked is the network transport — `jose`'s own `customFetch`
 * option serves the JWKS from memory instead of over HTTP, which is what
 * makes this deterministic and avoids conflicting with the adapter's
 * (correct, production-necessary) https-only URL validation.
 */
export interface TestIssuer {
  /** Use as SupabaseAdapterConfig.projectUrl. */
  readonly projectUrl: string;
  /** Pass as SupabaseAdapterConfig.jwksOptions to route JWKS retrieval through this issuer's in-memory keys. */
  readonly jwksOptions: RemoteJWKSetOptions;
  signToken(overrides?: SignTokenOverrides): Promise<string>;
}

export interface SignTokenOverrides {
  sub?: string | null;
  iss?: string;
  alg?: 'ES256' | 'HS256';
  expiresInSeconds?: number;
  extraClaims?: Record<string, unknown>;
  /** Use a different (unrelated) keypair's private key — proves JWKS key-matching, not just "any valid signature". */
  signWithForeignKey?: boolean;
}

async function buildIssuer(): Promise<{ projectUrl: string; kid: string; privateKey: CryptoKey; jwksResponseBody: string }> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `test-key-${Math.random().toString(36).slice(2)}`;
  const publicJwk = await exportJWK(publicKey);
  const jwksResponseBody = JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }] });
  return { projectUrl: `https://test-${kid}.supabase.example`, kid, privateKey, jwksResponseBody };
}

export async function createTestIssuer(): Promise<TestIssuer> {
  const issuer = await buildIssuer();
  const foreign = await buildIssuer(); // an unrelated keypair, for the "wrong key" adversarial case

  const fetchImpl: RemoteJWKSetOptions[typeof customFetch] = async () =>
    new Response(issuer.jwksResponseBody, { status: 200, headers: { 'content-type': 'application/json' } });

  return {
    projectUrl: issuer.projectUrl,
    jwksOptions: { [customFetch]: fetchImpl },
    async signToken(overrides: SignTokenOverrides = {}): Promise<string> {
      const alg = overrides.alg ?? 'ES256';
      const signingKey = overrides.signWithForeignKey ? foreign.privateKey : issuer.privateKey;
      const kid = overrides.signWithForeignKey ? foreign.kid : issuer.kid;

      let builder = new SignJWT({ role: 'authenticated', ...overrides.extraClaims })
        .setProtectedHeader({ alg, kid })
        .setIssuedAt()
        .setIssuer(overrides.iss ?? `${issuer.projectUrl}/auth/v1`)
        .setExpirationTime(Math.floor(Date.now() / 1000) + (overrides.expiresInSeconds ?? 3600));

      if (overrides.sub !== null) {
        builder = builder.setSubject(overrides.sub ?? 'test-user-subject-1');
      }

      if (alg === 'HS256') {
        const { generateSecret } = await import('jose');
        const secret = await generateSecret('HS256', { extractable: true });
        return builder.sign(secret);
      }

      return builder.sign(signingKey);
    },
  };
}

/** A customFetch that simulates the JWKS endpoint being unreachable — for the provider-outage test. */
export const unreachableFetch: RemoteJWKSetOptions[typeof customFetch] = async () => {
  throw new TypeError('simulated network failure: JWKS endpoint unreachable');
};
