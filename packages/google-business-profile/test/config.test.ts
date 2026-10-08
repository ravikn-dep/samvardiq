import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CredentialAccessDeniedError, CredentialStoreError, OAuthAuthorizationInvalidError } from '@samvardiq/platform-credentials';

import {
  classifyGbpError,
  GbpConfigurationError,
  GbpConflictError,
  GbpNotConfiguredError,
  GoogleOAuthClient,
  GoogleUnavailableError,
  isAllowedRedirectUri,
  loadGbpConfigFromEnv,
} from '../src/index.js';
import { displayText } from '../src/google.js';

const ID = '1234-abc.apps.googleusercontent.com';
const env = (over: Record<string, string | undefined> = {}) => ({ GBP_OAUTH_CLIENT_ID: ID, GBP_OAUTH_CLIENT_SECRET: 'GOCSPX-x', GBP_OAUTH_REDIRECT_URIS: 'https://app.example.test/cb,http://127.0.0.1:53682/callback', ...over });

test('config: none set → integration off; all set → parsed exactly', () => {
  assert.equal(loadGbpConfigFromEnv({}), null);
  assert.deepEqual(loadGbpConfigFromEnv(env()), { clientId: ID, clientSecret: 'GOCSPX-x', redirectUris: ['https://app.example.test/cb', 'http://127.0.0.1:53682/callback'] });
});

test('config: partial or malformed refuses startup, naming the variable but never its value', () => {
  for (const bad of [
    env({ GBP_OAUTH_CLIENT_SECRET: undefined }),
    env({ GBP_OAUTH_REDIRECT_URIS: undefined }),
    env({ GBP_OAUTH_CLIENT_ID: 'not-a-google-client' }),
    env({ GBP_OAUTH_REDIRECT_URIS: 'http://app.example.test/cb' }),
    env({ GBP_OAUTH_REDIRECT_URIS: 'https://app.example.test/cb?next=/x' }),
    env({ GBP_OAUTH_REDIRECT_URIS: 'https://app.example.test/cb#f' }),
    env({ GBP_OAUTH_REDIRECT_URIS: 'https://app.example.test' }),
    env({ GBP_OAUTH_CLIENT_SECRET: 'has space' }),
  ]) {
    assert.throws(() => loadGbpConfigFromEnv(bad), (e: Error) => e instanceof GbpConfigurationError && !e.message.includes('GOCSPX') && !e.message.includes('has space'));
  }
});

test('redirect URIs: https or loopback http, canonical, no query/fragment/userinfo', () => {
  assert.ok(isAllowedRedirectUri('https://a.example/cb'));
  assert.ok(isAllowedRedirectUri('http://localhost:8080/cb'));
  for (const bad of ['http://a.example/cb', 'https://u:p@a.example/cb', 'https://a.example/cb?x', 'javascript:x', 'https://A.example/cb', 'https://a.example/./cb']) assert.equal(isAllowedRedirectUri(bad), false, bad);
});

test('authorization URL carries no secret and requests exactly the documented parameters', () => {
  const url = new URL(new GoogleOAuthClient({ clientId: ID, clientSecret: 'GOCSPX-secret' }).authorizationUrl({ state: 's'.repeat(43), codeChallenge: 'c'.repeat(43), redirectUri: 'https://a.example/cb' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'include_granted_scopes', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state']);
  assert.ok(!url.toString().includes('GOCSPX'));
});

test('display text: control, zero-width, bidi and separator characters removed; capped', () => {
  assert.equal(displayText(`a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c${String.fromCharCode(0x2028)}d${String.fromCharCode(0x200b)}e`, 50), 'a b c d e');
  assert.equal(displayText('x'.repeat(500), 10), 'x'.repeat(10));
  assert.equal(displayText(42, 10), '');
});

test('error classification: fixed client-safe messages and statuses', () => {
  assert.deepEqual(classifyGbpError(new CredentialAccessDeniedError()), { httpStatus: 403, message: 'Access denied.' });
  assert.equal(classifyGbpError(new OAuthAuthorizationInvalidError())?.httpStatus, 400);
  assert.equal(classifyGbpError(new GbpNotConfiguredError())?.httpStatus, 503);
  assert.equal(classifyGbpError(new GoogleUnavailableError())?.httpStatus, 503);
  assert.equal(classifyGbpError(new GbpConflictError('bound_elsewhere'))?.httpStatus, 409);
  assert.equal(classifyGbpError(new CredentialStoreError('23505'))?.httpStatus, 409);
  assert.equal(classifyGbpError(new CredentialStoreError('08006')), null, 'unclassified → generic 500 by the server');
  assert.equal(classifyGbpError(new Error('x')), null);
});
