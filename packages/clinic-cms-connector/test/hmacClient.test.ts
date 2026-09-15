import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { signClinicCmsRequest } from '../src/hmacClient.js';

/**
 * Reference-vector tests (section 14) — every expected value below is
 * computed independently, directly from Node's `crypto` module, NOT by
 * calling `signClinicCmsRequest` a second time. This proves the
 * implementation against an independent computation of the documented
 * algorithm, not merely against itself.
 */

const SECRET = 'reference-vector-secret-at-least-32-characters-long';

function independentSignature(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

test('R: produces the exact HMAC-SHA256 lowercase-hex digest documented by Clinic CMS for a bodyless GET', () => {
  const expected = independentSignature('2026-08-12T08:30:00.000Z.va-20260812-000001.GET./api/external/v1/health.{}');
  const actual = signClinicCmsRequest({
    secret: SECRET,
    timestamp: '2026-08-12T08:30:00.000Z',
    requestId: 'va-20260812-000001',
    method: 'GET',
    path: '/api/external/v1/health',
    rawBody: '{}',
  });
  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{64}$/, 'digest must be lowercase hex, exactly 64 characters');
});

test('R: produces the exact digest for a POST with a real JSON body', () => {
  const rawBody = JSON.stringify({ appointmentDate: '2026-08-14', appointmentTime: '11:30' });
  const expected = independentSignature(`2026-08-12T08:30:00.000Z.va-20260812-000008.POST./api/external/v1/appointments/APT-1/reschedule.${rawBody}`);
  const actual = signClinicCmsRequest({
    secret: SECRET,
    timestamp: '2026-08-12T08:30:00.000Z',
    requestId: 'va-20260812-000008',
    method: 'POST',
    path: '/api/external/v1/appointments/APT-1/reschedule',
    rawBody,
  });
  assert.equal(actual, expected);
});

test('normalizes method case — lowercase input method produces the same signature as uppercase', () => {
  const a = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r', method: 'get', path: '/x', rawBody: '{}' });
  const b = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r', method: 'GET', path: '/x', rawBody: '{}' });
  assert.equal(a, b);
});

test('query-string semantics: a path carrying a query string is signed WITHOUT the query string, matching CMS`s own req.originalUrl.split("?")[0]', () => {
  const withQuery = signClinicCmsRequest({
    secret: SECRET,
    timestamp: 't',
    requestId: 'r',
    method: 'GET',
    path: '/api/external/v1/consultants/7/slots?date=2026-08-13',
    rawBody: '{}',
  });
  const withoutQuery = signClinicCmsRequest({
    secret: SECRET,
    timestamp: 't',
    requestId: 'r',
    method: 'GET',
    path: '/api/external/v1/consultants/7/slots',
    rawBody: '{}',
  });
  assert.equal(withQuery, withoutQuery, 'the query string must never affect the signature');
});

test('body mutation changes the signature', () => {
  const a = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r', method: 'POST', path: '/x', rawBody: '{"a":1}' });
  const b = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r', method: 'POST', path: '/x', rawBody: '{"a":2}' });
  assert.notEqual(a, b);
});

test('path mutation changes the signature', () => {
  const a = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r', method: 'GET', path: '/x', rawBody: '{}' });
  const b = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r', method: 'GET', path: '/y', rawBody: '{}' });
  assert.notEqual(a, b);
});

test('requestId mutation changes the signature', () => {
  const a = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r1', method: 'GET', path: '/x', rawBody: '{}' });
  const b = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r2', method: 'GET', path: '/x', rawBody: '{}' });
  assert.notEqual(a, b);
});

test('timestamp mutation changes the signature', () => {
  const a = signClinicCmsRequest({ secret: SECRET, timestamp: 't1', requestId: 'r', method: 'GET', path: '/x', rawBody: '{}' });
  const b = signClinicCmsRequest({ secret: SECRET, timestamp: 't2', requestId: 'r', method: 'GET', path: '/x', rawBody: '{}' });
  assert.notEqual(a, b);
});

test('a different secret produces a different signature for the identical payload', () => {
  const a = signClinicCmsRequest({ secret: SECRET, timestamp: 't', requestId: 'r', method: 'GET', path: '/x', rawBody: '{}' });
  const b = signClinicCmsRequest({ secret: 'a-completely-different-secret-value-32chars', timestamp: 't', requestId: 'r', method: 'GET', path: '/x', rawBody: '{}' });
  assert.notEqual(a, b);
});
