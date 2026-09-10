import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWorld, provisionMember } from './setup.js';

/** AD-AG, AO, AU, AV, AW, AX of the adversarial matrix — error mapping, sanitization, and transport-hygiene. */

test('AD/AE/AF/AG: a 403 denial response never contains the token, provider subject, internal identityId, or SQL/RLS detail', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });
  const res = await world.app.inject({
    method: 'GET',
    url: '/v1/organizations/org-B/goals',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 403);
  const body = res.body;
  for (const secret of [token, 'sub-1', 'id-1', 'select', 'insert', 'SQLSTATE', 'row-level security', 'app.current_org_id']) {
    assert.ok(!body.toLowerCase().includes(secret.toLowerCase()), `403 body leaked "${secret}"`);
  }
  assert.deepEqual(res.json(), { error: 'Access denied.' });
  await world.app.close();
});

test('AD: a 401 denial response never contains the raw token', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({
    method: 'GET',
    url: '/v1/organizations/org-A/goals',
    headers: { authorization: 'Bearer not-a-real-jwt' },
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: 'Authentication required.' });
  assert.ok(!res.body.includes('not-a-real-jwt'));
  await world.app.close();
});

test('AU: an internal (500-class) error never leaks a stack trace or raw message, in production mode', async () => {
  const world = await buildWorld({ nodeEnv: 'production' });
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  // Break the protected service AFTER authorization succeeds, simulating an unexpected internal failure.
  world.goalReadService.listGoals = async () => {
    throw new Error('simulated internal failure: connection to secret-internal-host refused');
  };

  const res = await world.app.inject({
    method: 'GET',
    url: '/v1/organizations/org-A/goals',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: 'Internal server error.' });
  assert.ok(!res.body.includes('secret-internal-host'));
  assert.ok(!res.body.includes('at ')); // no stack-trace-shaped content
  await world.app.close();
});

test('AV: an unknown route returns a safe 404', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({ method: 'GET', url: '/v1/does-not-exist' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'Not Found' });
  await world.app.close();
});

test('AW: an unsupported method on a known route returns a safe response, not a 500', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({ method: 'POST', url: '/v1/organizations/org-A/goals' });
  assert.equal(res.statusCode, 404); // Fastify has no route registered for POST on this path
  await world.app.close();
});

test('AO: a malformed organizationId is rejected by schema validation before any business logic runs (400)', async () => {
  const world = await buildWorld();
  let calls = 0;
  const original = world.goalReadService.listGoals.bind(world.goalReadService);
  world.goalReadService.listGoals = async (context) => {
    calls += 1;
    return original(context);
  };
  const token = await world.issuer.signToken();

  const res = await world.app.inject({
    method: 'GET',
    url: '/v1/organizations/../../etc%2Fpasswd/goals',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400/404, got ${res.statusCode}`);
  assert.equal(calls, 0, 'malformed organizationId must never reach the protected application service');
  await world.app.close();
});

test('AO (variant): an empty organizationId segment is rejected by schema validation (400)', async () => {
  const world = await buildWorld();
  const token = await world.issuer.signToken();
  const res = await world.app.inject({ method: 'GET', url: '/v1/organizations//goals', headers: { authorization: `Bearer ${token}` } });
  assert.ok(res.statusCode === 400 || res.statusCode === 404);
  await world.app.close();
});

test('AX: an oversized request payload is rejected (413), never processed', async () => {
  const world = await buildWorld();
  // GET/HEAD requests are not body-parsed by Fastify at all (no route in this
  // session accepts a body on GET), so the bodyLimit check is exercised via a
  // method Fastify does attempt to parse a body for.
  const res = await world.app.inject({
    method: 'POST',
    url: '/health',
    headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024) },
    payload: 'x'.repeat(64 * 1024),
  });
  assert.equal(res.statusCode, 413);
  await world.app.close();
});
