import {
  GoogleAuthorizationRejectedError,
  GoogleRequestRejectedError,
  GoogleRateLimitedError,
  GoogleResponseInvalidError,
  GoogleScopeNotGrantedError,
  GoogleUnavailableError,
  GbpTooManyResourcesError,
} from './errors.js';
import { ProviderCredentialRejectedError } from '@samvardiq/platform-credentials';

/**
 * Google endpoints and facts verified against Google's official documentation
 * on 2026-10-08 (sources: docs/integrations/GOOGLE_BUSINESS_PROFILE_ARCHITECTURE.md §1).
 */
export const GBP_PROVIDER = 'google_business_profile';
/** The only Business Profile scope Google offers. It permits writes; Samvardiq W1 enforces read-only itself (below). */
export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const GBP_CREDENTIAL_TYPE = 'oauth_refresh_token';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ACCOUNTS_ENDPOINT = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const LOCATIONS_ENDPOINT = (accountName: string) => `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`;
const TIMEOUT_MS = 10_000;

/** W1 discovery bounds (pilot): one page of accounts, five pages of locations per account. Exceeding them fails closed. */
const MAX_ACCOUNTS = 20;
const LOCATION_PAGE_SIZE = 100;
const MAX_LOCATION_PAGES = 5;

/** The minimal fetch surface used here — injectable so tests can emulate Google without network access. */
export type HttpFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string;
  grantedScopes: string[];
}

export interface GbpAccount {
  accountName: string;
  displayName: string;
  type: string;
}

export interface GbpLocation {
  locationName: string;
  accountName: string;
  accountDisplayName: string;
  title: string;
  addressSummary: string | null;
}

const ACCOUNT_NAME = /^accounts\/[A-Za-z0-9_-]{1,64}$/;
const LOCATION_NAME = /^locations\/[A-Za-z0-9_-]{1,64}$/;

/** Provider metadata is untrusted display text (AM): control, bidi-override and line-separator characters removed, whitespace collapsed, length capped. */
export function displayText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const unsafe = (c: number) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff;
  return [...value].map((ch) => (unsafe(ch.codePointAt(0)!) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function send(fetchImpl: HttpFetch, url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<{ status: number; body: unknown }> {
  let response: Awaited<ReturnType<HttpFetch>>;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // Network failure / timeout. The original error is dropped: it can carry the request (and its credential).
    throw new GoogleUnavailableError();
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

function failFor(status: number): never {
  if (status === 429) throw new GoogleRateLimitedError();
  if (status >= 500) throw new GoogleUnavailableError();
  throw new GoogleRequestRejectedError();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oauthError = (body: unknown) => (isRecord(body) && typeof body.error === 'string' ? body.error : undefined);

/**
 * OAuth 2.0 authorization-code flow with PKCE for a confidential web client.
 * The client secret and every token stay server-side; nothing here logs, and
 * no error carries a provider response body.
 */
export class GoogleOAuthClient {
  constructor(
    private readonly config: GoogleOAuthClientConfig,
    private readonly fetchImpl: HttpFetch = globalThis.fetch as unknown as HttpFetch,
  ) {}

  /** `access_type=offline` + `prompt=consent` so Google always issues a refresh token; incremental scopes are not merged in. */
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: GBP_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<GoogleTokenSet> {
    const { status, body } = await this.#token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier });
    if (status !== 200) {
      // invalid_grant: the code is unknown, expired, already used, or was issued for another redirect/verifier (N, O, Q).
      if (oauthError(body) === 'invalid_grant') throw new GoogleAuthorizationRejectedError();
      failFor(status);
    }
    if (!isRecord(body)) throw new GoogleResponseInvalidError();
    const accessToken = tokenField(body.access_token, 4096);
    const refreshToken = tokenField(body.refresh_token, 2048);
    if (body.token_type !== 'Bearer' || typeof body.scope !== 'string') throw new GoogleResponseInvalidError();
    const grantedScopes = body.scope.split(' ').filter(Boolean);
    // Granular consent: the user may untick the permission. Without it nothing is stored.
    if (!grantedScopes.includes(GBP_SCOPE)) throw new GoogleScopeNotGrantedError();
    return { accessToken, refreshToken, grantedScopes };
  }

  /**
   * Server-side refresh (service-principal path only, via ARCH-020 useCredential).
   * `invalid_grant` (revoked, expired, or superseded refresh token) becomes
   * ProviderCredentialRejectedError, which moves the connection to NEEDS_REAUTH.
   * Google does not rotate refresh tokens on refresh; a returned one is ignored, and if
   * the old one ever stops working that same path asks the OWNER to reconnect.
   */
  async refreshAccessToken(refreshToken: string): Promise<string> {
    const { status, body } = await this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (status !== 200) {
      if (oauthError(body) === 'invalid_grant') throw new ProviderCredentialRejectedError();
      failFor(status);
    }
    if (!isRecord(body) || body.token_type !== 'Bearer') throw new GoogleResponseInvalidError();
    return tokenField(body.access_token, 4096);
  }

  #token(params: Record<string, string>) {
    return send(this.fetchImpl, TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...params, client_id: this.config.clientId, client_secret: this.config.clientSecret }).toString(),
    });
  }
}

function tokenField(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !/^[\x21-\x7e]+$/.test(value)) throw new GoogleResponseInvalidError();
  return value;
}

/**
 * THE Google Business Profile connector surface for GBP-W1 — read-only by
 * construction (Founder decision D1/G1): it has exactly two public methods,
 * both issue HTTP GET only, and only to the two documented read endpoints.
 * There is no method, and no code path anywhere in this package, that can
 * reply to reviews, edit profile information, create posts, change hours or
 * attributes, or upload or remove media. Tested in test/readOnly.test.ts.
 */
export class GbpReadClient {
  constructor(private readonly fetchImpl: HttpFetch = globalThis.fetch as unknown as HttpFetch) {}

  /** accounts.list — every account the authorized Google user can access (the user's PERSONAL account first). */
  async listAccounts(accessToken: string): Promise<GbpAccount[]> {
    const body = await this.#get(`${ACCOUNTS_ENDPOINT}?pageSize=${MAX_ACCOUNTS}`, accessToken);
    if (body.nextPageToken !== undefined) throw new GbpTooManyResourcesError();
    const accounts = body.accounts ?? [];
    if (!Array.isArray(accounts)) throw new GoogleResponseInvalidError();
    return accounts.map((a: unknown) => {
      if (!isRecord(a) || typeof a.name !== 'string' || !ACCOUNT_NAME.test(a.name)) throw new GoogleResponseInvalidError();
      return { accountName: a.name, displayName: displayText(a.accountName, 200), type: typeof a.type === 'string' ? a.type : 'UNSPECIFIED' };
    });
  }

  /** accounts.locations.list — only the minimal identity/display fields needed to choose a location (readMask). */
  async listLocations(accessToken: string, account: GbpAccount): Promise<GbpLocation[]> {
    if (!ACCOUNT_NAME.test(account.accountName)) throw new GoogleResponseInvalidError();
    const locations: GbpLocation[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
      const query = new URLSearchParams({ readMask: 'name,title,storefrontAddress', pageSize: String(LOCATION_PAGE_SIZE), ...(pageToken ? { pageToken } : {}) });
      const body = await this.#get(`${LOCATIONS_ENDPOINT(account.accountName)}?${query}`, accessToken);
      const items = body.locations ?? [];
      if (!Array.isArray(items)) throw new GoogleResponseInvalidError();
      for (const l of items) {
        if (!isRecord(l) || typeof l.name !== 'string' || !LOCATION_NAME.test(l.name)) throw new GoogleResponseInvalidError();
        locations.push({ locationName: l.name, accountName: account.accountName, accountDisplayName: account.displayName, title: displayText(l.title, 200), addressSummary: addressSummary(l.storefrontAddress) });
      }
      if (body.nextPageToken === undefined) return locations;
      if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length > 1024) throw new GoogleResponseInvalidError();
      pageToken = body.nextPageToken;
    }
    throw new GbpTooManyResourcesError();
  }

  /** The ONLY request primitive of the connector: GET, bearer token in a header, never in a URL. */
  async #get(url: string, accessToken: string): Promise<Record<string, unknown>> {
    const { status, body } = await send(this.fetchImpl, url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (status !== 200) failFor(status);
    if (!isRecord(body)) throw new GoogleResponseInvalidError();
    return body;
  }
}

function addressSummary(address: unknown): string | null {
  if (!isRecord(address)) return null;
  const lines = Array.isArray(address.addressLines) ? address.addressLines : [];
  const parts = [...lines, address.locality, address.administrativeArea, address.postalCode].map((p) => displayText(p, 120)).filter(Boolean);
  return parts.length ? parts.join(', ').slice(0, 300) : null;
}
