import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryIdentityAuditRepository } from '../src/identityAuditRepository.js';
import type { AppendAuditEventInput } from '../src/identityAuditEvent.js';

/**
 * A, B, C, F, I, J, K, L of the IDENTITY-W6 adversarial matrix (unit level —
 * D/E/G/H/M/N/O/P/Q/R/Z/AA-AF require real PostgreSQL, see
 * test/integration/identityAudit.test.ts and
 * test/integration/membershipTransition.test.ts).
 */

function membershipEvent(overrides: Partial<AppendAuditEventInput> = {}): AppendAuditEventInput {
  return {
    organizationId: 'org-A',
    actor: { principalType: 'human', identityId: 'id-actor' },
    eventType: 'MEMBERSHIP_STATUS_CHANGED',
    targetType: 'MEMBERSHIP',
    targetId: 'org-A::id-target',
    outcome: 'SUCCESS',
    ...overrides,
  };
}

test('A: a valid organization-scoped audit event persists', async () => {
  const repo = new InMemoryIdentityAuditRepository();
  const event = await repo.append(membershipEvent());
  assert.equal(event.organizationId, 'org-A');
  const listed = await repo.listByOrganization('org-A');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.eventId, event.eventId);
});

test('B: a global event can be represented only through the intended path (organizationId absent, IDENTITY_*/PROVIDER_LINK_* event types)', async () => {
  const repo = new InMemoryIdentityAuditRepository();
  const event = await repo.append({
    actor: { principalType: 'system' },
    eventType: 'IDENTITY_CREATED',
    targetType: 'IDENTITY',
    targetId: 'id-new',
    outcome: 'SUCCESS',
  });
  assert.equal(event.organizationId, undefined);
  const globals = await repo.listGlobal();
  assert.equal(globals.length, 1);
  const orgScoped = await repo.listByOrganization('org-A');
  assert.equal(orgScoped.length, 0, 'a global event must never appear in an organization-scoped listing');
});

test('C: distinct organizations remain isolated in listByOrganization', async () => {
  const repo = new InMemoryIdentityAuditRepository();
  await repo.append(membershipEvent({ organizationId: 'org-A', targetId: 'org-A::id-1' }));
  await repo.append(membershipEvent({ organizationId: 'org-B', targetId: 'org-B::id-2' }));
  assert.equal((await repo.listByOrganization('org-A')).length, 1);
  assert.equal((await repo.listByOrganization('org-B')).length, 1);
});

test('F: target identity is structurally distinct from actor identity', async () => {
  const repo = new InMemoryIdentityAuditRepository();
  const event = await repo.append(membershipEvent({ actor: { principalType: 'human', identityId: 'id-actor' }, targetId: 'org-A::id-different-target' }));
  assert.equal(event.actor.principalType, 'human');
  assert.equal((event.actor as { identityId: string }).identityId, 'id-actor');
  assert.equal(event.targetId, 'org-A::id-different-target');
  assert.notEqual((event.actor as { identityId: string }).identityId, event.targetId);
});

test('I: occurredAt is repository/database-controlled, not caller-supplied — AppendAuditEventInput has no such field', async () => {
  const repo = new InMemoryIdentityAuditRepository();
  const before = Date.now();
  const event = await repo.append(membershipEvent());
  const after = Date.now();
  const occurredAtMs = new Date(event.occurredAt).getTime();
  assert.ok(occurredAtMs >= before && occurredAtMs <= after, 'occurredAt must reflect actual append time, not a caller-supplied value');
});

test('J: eventId is repository-generated and unique across appends — never client-selected (AppendAuditEventInput carries no eventId field)', async () => {
  const repo = new InMemoryIdentityAuditRepository();
  const e1 = await repo.append(membershipEvent());
  const e2 = await repo.append(membershipEvent());
  assert.notEqual(e1.eventId, e2.eventId);
  assert.match(e1.eventId, /^[0-9a-f-]{36}$/i);
});

test('K/L: the repository interface exposes no update or delete method', () => {
  const repo = new InMemoryIdentityAuditRepository();
  assert.equal((repo as unknown as Record<string, unknown>).update, undefined);
  assert.equal((repo as unknown as Record<string, unknown>).delete, undefined);
});

test('an appended event is frozen — cannot be mutated in place after the fact', async () => {
  const repo = new InMemoryIdentityAuditRepository();
  const event = await repo.append(membershipEvent());
  assert.throws(() => {
    (event as { outcome: string }).outcome = 'FAILED';
  });
});

test('unsafe reason/metadata are rejected before an event is ever stored', async () => {
  const repo = new InMemoryIdentityAuditRepository();
  await assert.rejects(repo.append(membershipEvent({ reason: 'Bearer abc.def.ghi' })));
  assert.equal((await repo.listByOrganization('org-A')).length, 0, 'a rejected append must not leave a partial record');
});
