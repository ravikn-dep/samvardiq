import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvalidJobError, JobFailure, UnknownJobTypeError } from '../src/errors.js';
import { backoffMs, DEFAULT_BACKOFF } from '../src/queue.js';
import { JobRegistry, validatePayload, type JobDefinition } from '../src/registry.js';

const noop = async () => undefined;
const DEF: JobDefinition = { type: 'test.org_job', scope: 'organization', payload: { period: 'date', batch: 'id', count: 'int' }, maxAttempts: 3, handle: noop };

describe('payload contract (identifiers only)', () => {
  test('A: valid identifiers, dates and integers are accepted and frozen', () => {
    const p = validatePayload(DEF, { period: '2026-10-06', batch: 'conv-batch:42', count: 3 });
    assert.deepEqual(p, { period: '2026-10-06', batch: 'conv-batch:42', count: 3 });
    assert.ok(Object.isFrozen(p));
  });

  const rejected: [string, unknown][] = [
    ['W undeclared key', { period: '2026-10-06', extra: 'x' }],
    ['W nested object', { batch: { id: 'x' } }],
    ['W array value', { batch: ['a'] }],
    ['W array payload', ['a']],
    ['W non-plain object', new Date()],
    ['W null', null],
    ['W wrong kind (number for id)', { batch: 7 }],
    ['W invalid date', { period: '2026-13-45' }],
    ['W negative int', { count: -1 }],
    ['W float', { count: 1.5 }],
    ['X oversized (value > 100 chars)', { batch: 'a'.repeat(101) }],
    ['Z/AA free text with spaces', { batch: 'Ravi Kumar has chest pain' }],
    ['AA message-like text', { batch: 'hello,please-call' }],
    ['AC JWT', { batch: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc' }],
    ['AC Google access token', { batch: 'ya29.a0AfB_byC' }],
    ['AC Google refresh token', { batch: '1//0gAbCdEf' }],
    ['AC Meta token', { batch: 'EAAGm0PX4ZCpsBAKxyz' }],
    ['AC API key', { batch: 'sk_live_abc123' }],
    ['AD executable-looking value', { batch: "require('child_process')" }],
    ['AD template injection', { batch: '${process.env}' }],
    ['AD prototype key', JSON.parse('{"__proto__": {"polluted": "yes"}}')],
  ];
  for (const [name, payload] of rejected) {
    test(`rejects: ${name}`, () => assert.throws(() => validatePayload(DEF, payload), InvalidJobError));
  }

  test('rejected errors name the field, never the value', () => {
    try {
      validatePayload(DEF, { batch: 'ya29.secret-value' });
      assert.fail();
    } catch (e) {
      assert.ok(e instanceof InvalidJobError);
      assert.ok(!e.message.includes('ya29') && !e.message.includes('secret-value'));
    }
  });

  test('X: total payload size is bounded (1024 bytes)', () => {
    // Every key and value individually valid (40-char keys, 100-char ids) but ~1.2 KB together.
    const keys = Array.from({ length: 8 }, (_, i) => `k${i}${'q'.repeat(38)}`);
    const wide: JobDefinition = { ...DEF, type: 'test.wide', payload: Object.fromEntries(keys.map((k) => [k, 'id' as const])) };
    assert.throws(() => validatePayload(wide, Object.fromEntries(keys.map((k) => [k, 'x'.repeat(100)]))), (e: unknown) => e instanceof InvalidJobError && e.field === 'payload size');
    assert.doesNotThrow(() => validatePayload(wide, Object.fromEntries(keys.slice(0, 6).map((k) => [k, 'x'.repeat(100)]))));
  });
});

describe('registry', () => {
  test('Y/Z/AA/AB/AC: a definition may not even declare a secret-, contact-, patient- or content-shaped key', () => {
    for (const key of ['accessToken', 'refreshToken', 'apiKey', 'clientSecret', 'password', 'phone', 'email', 'patientName', 'diagnosis', 'messageText', 'body', 'content', 'reviewText', 'comment', 'callbackUrl', 'authCode']) {
      assert.throws(() => new JobRegistry().register({ ...DEF, payload: { [key]: 'id' } }), InvalidJobError, key);
    }
  });

  test('V: unknown types fail safely; type names, duplicates and attempt bounds are validated', () => {
    const r = new JobRegistry().register(DEF);
    assert.throws(() => r.get('test.nope'), UnknownJobTypeError);
    assert.throws(() => r.get('constructor'), UnknownJobTypeError);
    assert.throws(() => r.register(DEF), InvalidJobError);
    for (const type of ['Test.Upper', 'a..b', '../x', 'x;drop', '']) assert.throws(() => new JobRegistry().register({ ...DEF, type }), InvalidJobError, type);
    for (const maxAttempts of [0, 26, 1.5]) assert.throws(() => new JobRegistry().register({ ...DEF, maxAttempts }), InvalidJobError);
  });

  test('JobFailure accepts only a sanitized snake_case class', () => {
    assert.equal(new JobFailure('retryable', 'rate_limited').failureClass, 'rate_limited');
    for (const bad of ['Rate Limited', 'x'.repeat(64), 'select 1;', 'postgres://u:p@h']) assert.throws(() => new JobFailure('permanent', bad), InvalidJobError);
  });
});

describe('backoff', () => {
  test('R: exponential, bounded jitter, capped at maxMs, deterministic under injected randomness', () => {
    assert.equal(backoffMs(1, DEFAULT_BACKOFF, () => 0.5), 30_000);
    assert.equal(backoffMs(2, DEFAULT_BACKOFF, () => 0.5), 60_000);
    assert.equal(backoffMs(3, DEFAULT_BACKOFF, () => 0.5), 120_000);
    assert.equal(backoffMs(1, DEFAULT_BACKOFF, () => 0), 24_000);
    assert.equal(backoffMs(1, DEFAULT_BACKOFF, () => 0.999999), 35_999);
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      for (const r of [0, 0.5, 0.9999]) assert.ok(backoffMs(attempt, DEFAULT_BACKOFF, () => r) <= DEFAULT_BACKOFF.maxMs);
    }
    assert.equal(backoffMs(20, DEFAULT_BACKOFF, () => 0.5), DEFAULT_BACKOFF.maxMs);
  });
});
