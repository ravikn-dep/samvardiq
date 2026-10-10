import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { GbpReadClient, GbpConnectionService, GoogleOAuthClient } from '../src/index.js';

/**
 * GBP-W1 write-risk boundary (Founder decision D1/G1): Google's only scope
 * permits writes, so read-only is enforced in Samvardiq's own code, not by
 * hiding UI. These checks fail if any write capability is ever added to the
 * W1 connector.
 */
const src = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(src, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts'))
  .map((e) => ({ path: join(e.parentPath, e.name), text: readFileSync(join(e.parentPath, e.name), 'utf8') }));

test('the connector exposes exactly two read methods', () => {
  assert.deepEqual(Object.getOwnPropertyNames(GbpReadClient.prototype).sort(), ['constructor', 'listAccounts', 'listLocations']);
});

test('the connection service has no Google write operation (its public methods are connection administration, discovery and verification)', () => {
  assert.deepEqual(Object.getOwnPropertyNames(GbpConnectionService.prototype).sort(), [
    'beginAuthorization',
    'bind',
    'completeAuthorization',
    'constructor',
    'disconnect',
    'refreshDiscovery',
    'status',
    'unbind',
    'verifyConnection',
  ]);
});

test('the OAuth client can only build the consent URL, exchange a code, refresh, and revoke — no business-API method', () => {
  assert.deepEqual(Object.getOwnPropertyNames(GoogleOAuthClient.prototype).sort(), ['authorizationUrl', 'constructor', 'exchangeCode', 'refreshAccessToken', 'revoke']);
});

test('no source file names a Google write endpoint, write verb or mutating resource', () => {
  const forbidden = [/\b(PATCH|PUT|DELETE)\b['"]/, /updateReply|deleteReply|localPosts|\/media\b|:patch|updateMask|attributes:|\/reviews\b|fetchMultiDailyMetrics|searchkeywords/i];
  for (const { path, text } of files) for (const re of forbidden) assert.doesNotMatch(text, re, `${path} matches ${re}`);
});

test('the only POSTs in the package are the OAuth token and revocation endpoints (BJ); the only hosts are Google OAuth and the two read APIs', () => {
  const posts = files.flatMap(({ path, text }) => [...text.matchAll(/method:\s*'POST'/g)].map(() => path));
  assert.equal(posts.length, 2);
  for (const p of posts) assert.match(p, /google\.ts$/);
  const google = files.find((f) => f.path.endsWith('google.ts'))!.text;
  assert.deepEqual([...google.matchAll(/'https:\/\/oauth2\.googleapis\.com\/([a-z]+)'/g)].map((m) => m[1]).sort(), ['revoke', 'token']);
  const hosts = new Set(files.flatMap(({ text }) => [...text.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1])));
  assert.deepEqual([...hosts].sort(), ['accounts.google.com', 'mybusinessaccountmanagement.googleapis.com', 'mybusinessbusinessinformation.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com']);
});

test('withdrawn APIs are not used (Q&A, Business Calls, v4 insights / direct-discovery metrics)', () => {
  for (const { path, text } of files) assert.doesNotMatch(text, /mybusinessqanda|businesscalls|reportInsights|QUERIES_DIRECT|QUERIES_INDIRECT/i, path);
});

test('no token, code or secret is ever written to a console/log', () => {
  for (const { path, text } of files) assert.doesNotMatch(text, /console\.|\.log\(|logger/, path);
});
