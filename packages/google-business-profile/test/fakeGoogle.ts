import { createHash, randomBytes } from 'node:crypto';

import type { HttpFetch } from '../src/index.js';

/**
 * A controllable emulation of the parts of Google this package talks to —
 * no network. It behaves like Google where security depends on it: an
 * authorization code is single-use, bound to the redirect URI and the PKCE
 * S256 challenge it was issued for, and requires the right client secret;
 * business endpoints require a live access token. It records every request so
 * tests can prove what was (and was not) sent.
 */
export interface GoogleUser {
  personal: string;
  accounts: { name: string; accountName: string; type: string }[];
  locations: Record<string, unknown[]>;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type Reply = { status: number; body: unknown };

export class FakeGoogle {
  readonly clientId = '1234567890-test.apps.googleusercontent.com';
  readonly clientSecret = `GOCSPX-${randomBytes(12).toString('hex')}`;
  readonly requests: RecordedRequest[] = [];
  /** Every token value ever issued — for leak scans. */
  readonly issued: string[] = [];
  readonly #codes = new Map<string, { user: GoogleUser; redirectUri: string; challenge: string; scope: string }>();
  readonly #refresh = new Map<string, GoogleUser>();
  readonly #access = new Map<string, GoogleUser>();
  /** Optional per-endpoint override, e.g. to simulate 5xx/429/malformed responses. */
  override: ((request: RecordedRequest) => Reply | undefined) | undefined;
  tokenResponseEdit: ((body: Record<string, unknown>) => Record<string, unknown>) | undefined;

  readonly fetch: HttpFetch = async (url, init) => {
    const request: RecordedRequest = { method: init.method, url, headers: init.headers, body: init.body };
    this.requests.push(request);
    const reply = this.override?.(request) ?? this.#handle(request);
    return { status: reply.status, json: async () => (reply.body === undefined ? Promise.reject(new SyntaxError('no json')) : reply.body) };
  };

  /** What Google's consent screen does when the user approves: returns the code it would put on the redirect. */
  consent(authorizationUrl: string, user: GoogleUser, grantedScope?: string): { code: string; state: string; redirectUri: string } {
    const url = new URL(authorizationUrl);
    const p = url.searchParams;
    if (url.origin + url.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth' || p.get('client_id') !== this.clientId || p.get('code_challenge_method') !== 'S256') throw new Error('bad authorization request');
    const code = `4/0A${randomBytes(16).toString('hex')}`;
    this.#codes.set(code, { user, redirectUri: p.get('redirect_uri')!, challenge: p.get('code_challenge')!, scope: grantedScope ?? p.get('scope')! });
    this.issued.push(code);
    return { code, state: p.get('state')!, redirectUri: p.get('redirect_uri')! };
  }

  revoke(user: GoogleUser): void {
    for (const [token, owner] of this.#refresh) if (owner === user) this.#refresh.delete(token);
  }

  #token(): string {
    const value = `ya29.${randomBytes(24).toString('hex')}`;
    this.issued.push(value);
    return value;
  }

  #handle(request: RecordedRequest): Reply {
    const url = new URL(request.url);
    if (request.method === 'POST' && request.url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(request.body);
      if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) return { status: 401, body: { error: 'invalid_client' } };
      if (form.get('grant_type') === 'authorization_code') {
        const grant = this.#codes.get(form.get('code') ?? '');
        this.#codes.delete(form.get('code') ?? ''); // single use, even when the exchange then fails
        const verifier = form.get('code_verifier') ?? '';
        if (!grant || grant.redirectUri !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) {
          return { status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } };
        }
        const refresh = `1//0g${randomBytes(24).toString('hex')}`;
        this.issued.push(refresh);
        this.#refresh.set(refresh, grant.user);
        const access = this.#token();
        this.#access.set(access, grant.user);
        const body = { access_token: access, expires_in: 3599, refresh_token: refresh, scope: grant.scope, token_type: 'Bearer' };
        return { status: 200, body: this.tokenResponseEdit ? this.tokenResponseEdit(body) : body };
      }
      if (form.get('grant_type') === 'refresh_token') {
        const user = this.#refresh.get(form.get('refresh_token') ?? '');
        if (!user) return { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
        const access = this.#token();
        this.#access.set(access, user);
        return { status: 200, body: { access_token: access, expires_in: 3599, scope: 'https://www.googleapis.com/auth/business.manage', token_type: 'Bearer' } };
      }
      return { status: 400, body: { error: 'unsupported_grant_type' } };
    }
    const user = this.#access.get((request.headers.Authorization ?? '').replace(/^Bearer /, ''));
    if (request.method !== 'GET') return { status: 405, body: { error: { code: 405 } } };
    if (!user) return { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED' } } };
    if (url.origin === 'https://mybusinessaccountmanagement.googleapis.com' && url.pathname === '/v1/accounts') return { status: 200, body: { accounts: user.accounts } };
    const match = /^\/v1\/(accounts\/[^/]+)\/locations$/.exec(url.pathname);
    if (url.origin === 'https://mybusinessbusinessinformation.googleapis.com' && match && url.searchParams.get('readMask')) {
      const account = match[1]!;
      if (!user.accounts.some((a) => a.name === account)) return { status: 403, body: { error: { code: 403 } } };
      return { status: 200, body: { locations: user.locations[account] ?? [] } };
    }
    return { status: 404, body: { error: { code: 404 } } };
  }
}

export function googleUser(personalId: string, extra: { groups?: { id: string; name: string }[]; locations: Record<string, { id: string; title: string; address?: unknown }[]> }): GoogleUser {
  const accounts = [{ name: `accounts/${personalId}`, accountName: 'Personal Owner', type: 'PERSONAL' }, ...(extra.groups ?? []).map((g) => ({ name: `accounts/${g.id}`, accountName: g.name, type: 'LOCATION_GROUP' }))];
  const locations = Object.fromEntries(
    Object.entries(extra.locations).map(([account, list]) => [`accounts/${account}`, list.map((l) => ({ name: `locations/${l.id}`, title: l.title, ...(l.address ? { storefrontAddress: l.address } : {}) }))]),
  );
  return { personal: `accounts/${personalId}`, accounts, locations };
}
