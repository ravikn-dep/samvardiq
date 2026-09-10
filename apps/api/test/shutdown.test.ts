import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWorld } from './setup.js';

/** AY: graceful shutdown stops accepting new requests once closed. */

test('AY: after close(), the server no longer accepts new requests', async () => {
  const world = await buildWorld();

  const before = await world.app.inject({ method: 'GET', url: '/health' });
  assert.equal(before.statusCode, 200);

  await world.app.close();

  await assert.rejects(() => world.app.inject({ method: 'GET', url: '/health' }));
});

test('AY: close() resolves (no hanging handles/connections hold the process open)', async () => {
  const world = await buildWorld();
  await world.app.inject({ method: 'GET', url: '/health' });
  await assert.doesNotReject(() => world.app.close());
});
