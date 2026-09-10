import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWorld } from './setup.js';

test('A: GET /health succeeds without auth', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await world.app.close();
});

test('B: /health leaks no sensitive configuration', async () => {
  const world = await buildWorld();
  const res = await world.app.inject({ method: 'GET', url: '/health' });
  const body = res.body;
  for (const secret of ['DATABASE_URL', 'SUPABASE', 'postgres://', 'password', 'token', 'jwks']) {
    assert.ok(!body.toLowerCase().includes(secret.toLowerCase()), `response leaked "${secret}"`);
  }
  assert.deepEqual(Object.keys(res.json()), ['status']);
  await world.app.close();
});
