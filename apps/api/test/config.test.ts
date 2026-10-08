import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ConfigError, loadConfigFromEnv, runtimePoolConfig } from '../src/config.js';

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

/** INFRA-W1D-POOL-F1: four runtime pools share DATABASE_POOL_MAX; the budget is 4 x it per instance, so it must never drift back to pg's 10. */
test('DATABASE_POOL_MAX defaults to 3 when unset or empty — omitting it never restores 4 x 10 = 40', () => {
  assert.equal(loadConfigFromEnv({} as NodeJS.ProcessEnv).databasePoolMax, 3);
  assert.equal(loadConfigFromEnv({ DATABASE_POOL_MAX: '' } as unknown as NodeJS.ProcessEnv).databasePoolMax, 3);
});

test('DATABASE_POOL_MAX accepts integers 1..20', () => {
  for (const [raw, max] of [['1', 1], ['3', 3], ['20', 20]] as const) {
    assert.equal(loadConfigFromEnv({ DATABASE_POOL_MAX: raw } as unknown as NodeJS.ProcessEnv).databasePoolMax, max);
  }
});

test('a malformed, zero, negative, decimal, padded or oversized DATABASE_POOL_MAX fails closed', () => {
  for (const raw of ['abc', '0', '-1', '2.5', '3.0', '1e1', ' 3', '3 ', '03', '+3', '21', '1000', '0x10']) {
    assert.throws(() => loadConfigFromEnv({ DATABASE_POOL_MAX: raw } as unknown as NodeJS.ProcessEnv), ConfigError, JSON.stringify(raw));
  }
});

test('runtimePoolConfig carries the budget and a finite acquisition timeout', () => {
  const pool = runtimePoolConfig(loadConfigFromEnv({ DATABASE_POOL_MAX: '3' } as unknown as NodeJS.ProcessEnv));
  assert.deepEqual(pool, { max: 3, connectionTimeoutMillis: 10_000 });
});

test('the composition root gives every runtime pool the bounded config (no pool falls back to pg defaults)', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/\bcreate\w*Client\(([^)]*)\)/g)].map((m) => m[1]);
  // Four package pools, plus the PLATFORM-JOBS-W1 queue pool and the GBP-W1 credential/GBP pool (each single-connection, only when enabled).
  assert.deepEqual(calls, ['poolConfig', 'poolConfig', 'poolConfig', 'poolConfig', '{ ...poolConfig, max: 1 }', '{ ...poolConfig, max: 1 }']);
  assert.match(source, /const poolConfig = runtimePoolConfig\(config\);/);
  assert.doesNotMatch(source, /new Pool\(/);
});

test('PLATFORM-JOBS-W1: worker and scheduler flags are independent and fail closed — absent = off, only exact "true" enables, anything else refuses startup', () => {
  const load = (env: Record<string, string>) => loadConfigFromEnv(env as unknown as NodeJS.ProcessEnv);
  assert.deepEqual([load({}).jobsWorkerEnabled, load({}).jobsSchedulerEnabled], [false, false]);
  assert.deepEqual([load({ JOBS_WORKER_ENABLED: 'true' }).jobsWorkerEnabled, load({ JOBS_WORKER_ENABLED: 'true' }).jobsSchedulerEnabled], [true, false]);
  assert.deepEqual([load({ JOBS_SCHEDULER_ENABLED: 'true' }).jobsWorkerEnabled, load({ JOBS_SCHEDULER_ENABLED: 'true' }).jobsSchedulerEnabled], [false, true]);
  assert.equal(load({ JOBS_WORKER_ENABLED: 'false', JOBS_SCHEDULER_ENABLED: 'false' }).jobsWorkerEnabled, false);
  for (const name of ['JOBS_WORKER_ENABLED', 'JOBS_SCHEDULER_ENABLED']) {
    for (const raw of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '', 'enabled']) {
      assert.throws(() => load({ [name]: raw }), (e: unknown) => e instanceof ConfigError && e.message.startsWith(`${name}:`), `${name}=${JSON.stringify(raw)}`);
    }
  }
});
