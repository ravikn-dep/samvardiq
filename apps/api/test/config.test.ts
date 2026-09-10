import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, loadConfigFromEnv } from '../src/config.js';

/** Section 32: fail-closed configuration. Every malformed input throws — never a silent, insecure default. */

test('defaults apply when nothing is set', () => {
  const config = loadConfigFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(config.port, 3000);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.nodeEnv, 'development');
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.trustProxy, false);
});

test('a non-numeric PORT fails closed', () => {
  assert.throws(() => loadConfigFromEnv({ PORT: 'not-a-number' } as unknown as NodeJS.ProcessEnv), ConfigError);
});

test('a PORT out of range fails closed', () => {
  assert.throws(() => loadConfigFromEnv({ PORT: '70000' } as unknown as NodeJS.ProcessEnv), ConfigError);
  assert.throws(() => loadConfigFromEnv({ PORT: '0' } as unknown as NodeJS.ProcessEnv), ConfigError);
});

test('ALLOWED_ORIGINS containing "*" fails closed — never a wildcard production default', () => {
  assert.throws(() => loadConfigFromEnv({ ALLOWED_ORIGINS: '*' } as unknown as NodeJS.ProcessEnv), ConfigError);
  assert.throws(() => loadConfigFromEnv({ ALLOWED_ORIGINS: 'https://a.example,*' } as unknown as NodeJS.ProcessEnv), ConfigError);
});

test('a malformed ALLOWED_ORIGINS entry fails closed', () => {
  assert.throws(() => loadConfigFromEnv({ ALLOWED_ORIGINS: 'not a url' } as unknown as NodeJS.ProcessEnv), ConfigError);
});

test('ALLOWED_ORIGINS parses a valid comma-separated list', () => {
  const config = loadConfigFromEnv({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual(config.allowedOrigins, ['https://a.example', 'https://b.example']);
});

test('an invalid NODE_ENV fails closed', () => {
  assert.throws(() => loadConfigFromEnv({ NODE_ENV: 'staging' } as unknown as NodeJS.ProcessEnv), ConfigError);
});

test('an invalid TRUST_PROXY value fails closed', () => {
  assert.throws(() => loadConfigFromEnv({ TRUST_PROXY: 'yes' } as unknown as NodeJS.ProcessEnv), ConfigError);
});

test('TRUST_PROXY defaults to false — X-Forwarded-* is never trusted unless explicitly enabled', () => {
  const config = loadConfigFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(config.trustProxy, false);
});
