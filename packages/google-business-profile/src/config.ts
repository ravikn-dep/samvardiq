import { GbpConfigurationError } from './errors.js';

/** Environment variable NAMES. Values live only in the hosting secret store; the client secret is never logged or returned. */
export const GBP_OAUTH_CLIENT_ID_ENV = 'GBP_OAUTH_CLIENT_ID';
export const GBP_OAUTH_CLIENT_SECRET_ENV = 'GBP_OAUTH_CLIENT_SECRET';
export const GBP_OAUTH_REDIRECT_URIS_ENV = 'GBP_OAUTH_REDIRECT_URIS';

export interface GbpOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Exact-match allow-list; each must also be registered on the Google OAuth client. */
  redirectUris: string[];
}

const CLIENT_ID = /^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/;

/**
 * None of the three set → null: the integration is off and its routes answer
 * 503, the rest of the API is unaffected. Some but not all, or any malformed →
 * refuse startup (a typo never half-enables an OAuth integration).
 */
export function loadGbpConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): GbpOAuthConfig | null {
  const clientId = env[GBP_OAUTH_CLIENT_ID_ENV]?.trim();
  const clientSecret = env[GBP_OAUTH_CLIENT_SECRET_ENV]?.trim();
  const rawUris = env[GBP_OAUTH_REDIRECT_URIS_ENV]?.trim();
  if (!clientId && !clientSecret && !rawUris) return null;
  if (!clientId || !CLIENT_ID.test(clientId)) throw new GbpConfigurationError(`${GBP_OAUTH_CLIENT_ID_ENV} is missing or not a Google OAuth web client ID`);
  if (!clientSecret || clientSecret.length > 256 || !/^[\x21-\x7e]+$/.test(clientSecret)) throw new GbpConfigurationError(`${GBP_OAUTH_CLIENT_SECRET_ENV} is missing or malformed`);
  if (!rawUris) throw new GbpConfigurationError(`${GBP_OAUTH_REDIRECT_URIS_ENV} is not set`);
  const redirectUris = rawUris.split(',').map((u) => u.trim());
  redirectUris.forEach((uri, index) => {
    if (!isAllowedRedirectUri(uri)) throw new GbpConfigurationError(`${GBP_OAUTH_REDIRECT_URIS_ENV} entry ${index + 1} must be an https URL (or http on 127.0.0.1/localhost) without query, fragment or credentials`);
  });
  return { clientId, clientSecret, redirectUris };
}

/** Google's rules (HTTPS except loopback) plus Samvardiq's: no query, fragment or userinfo, and the URL must already be in canonical form. */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  return (url.protocol === 'https:' || loopback) && !url.search && !url.hash && !url.username && !url.password && url.toString() === uri && uri.length <= 512;
}
