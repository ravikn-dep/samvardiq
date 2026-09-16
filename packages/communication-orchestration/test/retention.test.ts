import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computePurgeAfter, purgeExpiredMessageContent, RAW_MESSAGE_RETENTION_DAYS } from '../src/retention.js';

test('X: retention is bounded at exactly the Founder-approved 30-day maximum', () => {
  assert.equal(RAW_MESSAGE_RETENTION_DAYS, 30);
});

test('computePurgeAfter returns a timestamp exactly RAW_MESSAGE_RETENTION_DAYS in the future', () => {
  const from = new Date('2026-01-01T00:00:00.000Z');
  const purgeAfter = computePurgeAfter(from);
  assert.equal(purgeAfter, '2026-01-31T00:00:00.000Z');
});

test('Y: purgeExpiredMessageContent delegates to the repository, scoped to one organization', async () => {
  let calledWith: [string, Date | undefined] | undefined;
  const repo = { purgeExpired: async (organizationId: string, now?: Date) => { calledWith = [organizationId, now]; return 3; } };
  const result = await purgeExpiredMessageContent(repo, 'org-A');
  assert.equal(result, 3);
  assert.equal(calledWith?.[0], 'org-A');
});
