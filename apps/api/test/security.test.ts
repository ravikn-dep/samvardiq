import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { buildWorld, provisionMember } from './setup.js';

/** AH-AJ (logging/request id), AK-AL (CORS), AM-AN (rate limiting) of the adversarial matrix. */

function collectingLogStream(): { stream: NodeJS.WritableStream; lines: () => string[] } {
  let buffer = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    lines: () => buffer.split('\n').filter((line) => line.trim().length > 0),
  };
}

test('AH/AI: structured logs never contain the Authorization header or raw token, and carry a well-formed request id', async () => {
  const { stream, lines } = collectingLogStream();
  const world = await buildWorld({}, { loggerStream: stream });
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  const res = await world.app.inject({
    method: 'GET',
    url: '/v1/organizations/org-A/goals',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);

  const logLines = lines();
  assert.ok(logLines.length > 0, 'expected at least one structured log line');
  for (const line of logLines) {
    assert.ok(!line.includes(token), 'log line leaked the raw bearer token');
    assert.ok(!line.toLowerCase().includes('bearer'), 'log line leaked the Authorization scheme/value');
    const parsed: Record<string, unknown> = JSON.parse(line);
    if (typeof parsed.reqId === 'string') {
      assert.match(parsed.reqId, /^[0-9a-f-]{36}$/i, 'reqId should be a server-generated UUID');
    }
  }
  await world.app.close();
});

test('AJ: an inbound request-id header is never trusted (server always generates its own), and cannot inject log structure', async () => {
  const { stream, lines } = collectingLogStream();
  const world = await buildWorld({}, { loggerStream: stream });
  const malicious = `${'x'.repeat(10_000)}\n{"injected":"log-line"}`;

  const res = await world.app.inject({ method: 'GET', url: '/health', headers: { 'request-id': malicious } });
  assert.equal(res.statusCode, 200);

  const logLines = lines();
  assert.ok(logLines.length > 0);
  for (const line of logLines) {
    assert.ok(!line.includes(malicious), 'malicious request-id header leaked verbatim into a log line');
    const parsed: Record<string, unknown> = JSON.parse(line); // throws if injection corrupted the JSON structure
    if (typeof parsed.reqId === 'string') {
      assert.notEqual(parsed.reqId, malicious);
      assert.match(parsed.reqId, /^[0-9a-f-]{36}$/i);
    }
  }
  await world.app.close();
});

test('AK: a disallowed CORS origin never receives an Access-Control-Allow-Origin header', async () => {
  const world = await buildWorld({ allowedOrigins: ['https://app.samvardiq.example'] });
  const res = await world.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
  // CORS is enforced by the browser reading the response, not by blocking the request server-side (section 27).
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  await world.app.close();
});

test('AL: an allowed CORS origin receives the expected Access-Control-Allow-Origin header', async () => {
  const world = await buildWorld({ allowedOrigins: ['https://app.samvardiq.example'] });
  const res = await world.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://app.samvardiq.example' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://app.samvardiq.example');
  await world.app.close();
});

test('a request with no Origin header (server-to-server, curl) is always allowed — CORS only governs browser requests', async () => {
  const world = await buildWorld({ allowedOrigins: [] });
  const res = await world.app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  await world.app.close();
});

test('AM/AN: rate limiting activates under a configured threshold and never itself grants unauthorized access', async () => {
  const world = await buildWorld({ rateLimit: { max: 3, windowMs: 60_000 } });
  const results = [];
  for (let i = 0; i < 6; i += 1) {
    results.push(await world.app.inject({ method: 'GET', url: '/health' }));
  }
  const statuses = results.map((r) => r.statusCode);
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.ok(statuses.slice(3).every((s) => s === 429), `expected 429s after the threshold, got ${JSON.stringify(statuses)}`);

  // AN: being rate-limited on the public /health route must never leak into, or bypass, the protected route's own authorization.
  const protectedRes = await world.app.inject({ method: 'GET', url: '/v1/organizations/org-A/goals' });
  assert.ok([401, 429].includes(protectedRes.statusCode));
  assert.notEqual(protectedRes.statusCode, 200);
  await world.app.close();
});

test('security audit #18: a spoofed X-Forwarded-For header cannot be used to evade rate limiting when trustProxy is off (the default)', async () => {
  const world = await buildWorld({ trustProxy: false, rateLimit: { max: 2, windowMs: 60_000 } });
  // Two different spoofed client IPs, same underlying connection — with trustProxy
  // off, @fastify/rate-limit's default IP-based key must come from the real
  // socket address, not the attacker-controlled header, so both share one bucket.
  const r1 = await world.app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '1.1.1.1' } });
  const r2 = await world.app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '2.2.2.2' } });
  const r3 = await world.app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '3.3.3.3' } });
  assert.deepEqual([r1.statusCode, r2.statusCode], [200, 200]);
  assert.equal(r3.statusCode, 429, 'a spoofed X-Forwarded-For must not grant a fresh rate-limit bucket');
  await world.app.close();
});
