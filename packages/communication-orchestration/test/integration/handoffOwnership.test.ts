import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { PostgresConversationRepository } from '../../src/postgres/conversationRepository.js';
import { pgErrorCode, withOrganizationContext } from '../../src/postgres/client.js';
import { conversationHandoffs, conversations } from '../../src/postgres/schema.js';
import type { Conversation } from '../../src/types.js';
import { startHarness, type Harness } from './harness.js';

/**
 * CLINIC-W2D, proven against real disposable PostgreSQL as the real samvardiq_app role: claim concurrency, state +
 * audit atomicity, RLS on the new log, append-only enforcement, and the one-owner-only-while-HUMAN_ACTIVE CHECK.
 */

const PORT = 55811;
let harness: Harness;
let repo: PostgresConversationRepository;

before(async () => {
  harness = await startHarness(PORT);
  repo = new PostgresConversationRepository(harness.app.db);
}, { timeout: 60_000 });

after(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.truncateAll();
});

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = new Date().toISOString();
  return {
    conversationId: 'conv-1',
    organizationId: 'org-A',
    channelId: 'chan-1',
    externalContactId: '919876543210',
    state: 'HUMAN_HANDOFF_REQUESTED',
    preferredLanguage: 'en-IN',
    bookingState: 'HUMAN_HANDOFF_REQUESTED',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Creates a handed-off conversation with booking state the way the real pipeline leaves it. */
async function seedHandoff(overrides: Partial<Conversation> = {}): Promise<Conversation> {
  const created = await repo.create(conversation(overrides));
  return repo.update({
    ...created,
    state: 'HUMAN_HANDOFF_REQUESTED',
    bookingState: 'HUMAN_HANDOFF_REQUESTED',
    bookingConsultantId: '7',
    bookingDate: '2026-08-13',
    bookingSlot: '09:00',
    bookingIdempotencyKey: 'old-key',
    externalPatientId: 'PAT-1',
    activeEnquiryId: 'ENQ-1',
    activeAppointmentId: 'APT-1',
    handoffTrigger: 'BOOKING_ALREADY_IN_PROGRESS',
    handoffAt: new Date().toISOString(),
    ...overrides,
  });
}

async function rawRow(organizationId: string, conversationId: string) {
  const { rows } = await harness.owner.pool.query('select * from conversations where organization_id = $1 and conversation_id = $2', [organizationId, conversationId]);
  return rows[0];
}

async function eventCount(organizationId = 'org-A', conversationId = 'conv-1'): Promise<number> {
  const { rows } = await harness.owner.pool.query('select count(*)::int as n from conversation_handoffs where organization_id = $1 and conversation_id = $2', [organizationId, conversationId]);
  return rows[0].n;
}

test('B: 20 rounds of 10 concurrent claims by different humans — exactly one winner, one CLAIMED row, the owner is the winner', async () => {
  for (let round = 0; round < 20; round += 1) {
    await harness.truncateAll();
    await seedHandoff();
    const claimers = Array.from({ length: 10 }, (_, i) => `staff-${i}`);
    const results = await Promise.all(claimers.map((who) => repo.claimHumanHandoff('org-A', 'conv-1', who)));
    const winners = results.flatMap((r, i) => (r.kind === 'CLAIMED' ? [claimers[i]] : []));
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results.map((r) => r.kind))}`);
    assert.equal(results.filter((r) => r.kind === 'CONFLICT').length, 9);
    assert.equal((await rawRow('org-A', 'conv-1')).handoff_owner_identity_id, winners[0]);
    assert.equal(await eventCount(), 1);
  }
});

test('claim vs resolve race: the owner resolving while others try to claim never yields a second owner or a lost event', async () => {
  await seedHandoff();
  assert.equal((await repo.claimHumanHandoff('org-A', 'conv-1', 'owner')).kind, 'CLAIMED');
  const [resolved, ...claims] = await Promise.all([
    repo.resolveHumanHandoff('org-A', 'conv-1', 'owner', 'CLOSE'),
    ...Array.from({ length: 5 }, (_, i) => repo.claimHumanHandoff('org-A', 'conv-1', `other-${i}`)),
  ]);
  assert.equal(resolved!.kind, 'RESOLVED');
  assert.ok(claims.every((c) => c.kind === 'CONFLICT'));
  const row = await rawRow('org-A', 'conv-1');
  assert.deepEqual({ state: row.state, owner: row.handoff_owner_identity_id }, { state: 'CLOSED', owner: null });
  assert.equal(await eventCount(), 2);
});

test('S/AA/AB in PostgreSQL: RETURN_TO_AI NULLs every transient journey field (including the idempotency key) and keeps history', async () => {
  await seedHandoff();
  await repo.claimHumanHandoff('org-A', 'conv-1', 'owner');
  await repo.resolveHumanHandoff('org-A', 'conv-1', 'owner', 'RETURN_TO_AI');
  const row = await rawRow('org-A', 'conv-1');
  assert.deepEqual(
    {
      state: row.state, booking: row.booking_state, key: row.booking_idempotency_key, consultant: row.booking_consultant_id, date: row.booking_date, slot: row.booking_slot,
      trigger: row.handoff_trigger, at: row.handoff_at, owner: row.handoff_owner_identity_id, claimed: row.handoff_claimed_at,
    },
    { state: 'AI_ACTIVE', booking: 'NEW', key: null, consultant: null, date: null, slot: null, trigger: null, at: null, owner: null, claimed: null },
  );
  assert.deepEqual({ patient: row.external_patient_id, enquiry: row.active_enquiry_id, appointment: row.active_appointment_id, language: row.preferred_language }, { patient: 'PAT-1', enquiry: 'ENQ-1', appointment: 'APT-1', language: 'en-IN' });
  const events = await repo.listHandoffEvents('org-A', 'conv-1');
  assert.deepEqual(events.map((e) => [e.eventType, e.actorIdentityId, e.outcome ?? null, e.handoffTrigger ?? null]), [
    ['CLAIMED', 'owner', null, 'BOOKING_ALREADY_IN_PROGRESS'],
    ['RESOLVED', 'owner', 'RETURN_TO_AI', 'BOOKING_ALREADY_IN_PROGRESS'],
  ]);
});

test('W/X in PostgreSQL: concurrent reopen of one CLOSED conversation succeeds exactly once, with one service-attributed REOPENED row', async () => {
  await seedHandoff();
  await repo.claimHumanHandoff('org-A', 'conv-1', 'owner');
  await repo.resolveHumanHandoff('org-A', 'conv-1', 'owner', 'CLOSE');
  const results = await Promise.all(Array.from({ length: 6 }, () => repo.reopenClosedConversation('org-A', 'conv-1', 'svc-chan-1')));
  assert.equal(results.filter(Boolean).length, 1);
  const reopened = (await repo.listHandoffEvents('org-A', 'conv-1')).filter((e) => e.eventType === 'REOPENED');
  assert.deepEqual(reopened.map((e) => [e.actorIdentityId, e.actorPrincipalType]), [['svc-chan-1', 'service']]);
  const row = await rawRow('org-A', 'conv-1');
  assert.deepEqual({ state: row.state, booking: row.booking_state, key: row.booking_idempotency_key, patient: row.external_patient_id }, { state: 'AI_ACTIVE', booking: 'NEW', key: null, patient: 'PAT-1' });
  assert.equal(await repo.reopenClosedConversation('org-A', 'conv-1', 'svc-chan-1'), null, 'not CLOSED any more: no second reopen');
});

test('N/AD: if the audit insert fails, the claim, resolution and reopen state changes all roll back', async () => {
  await seedHandoff();
  await harness.owner.pool.query(`CREATE FUNCTION w2d_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`);
  await harness.owner.pool.query('CREATE TRIGGER w2d_fail_audit BEFORE INSERT ON conversation_handoffs FOR EACH ROW EXECUTE FUNCTION w2d_fail_audit()');
  try {
    await assert.rejects(repo.claimHumanHandoff('org-A', 'conv-1', 'owner'));
    let row = await rawRow('org-A', 'conv-1');
    assert.deepEqual({ state: row.state, owner: row.handoff_owner_identity_id }, { state: 'HUMAN_HANDOFF_REQUESTED', owner: null }, 'claim rolled back');

    await harness.owner.pool.query('ALTER TABLE conversation_handoffs DISABLE TRIGGER w2d_fail_audit');
    await repo.claimHumanHandoff('org-A', 'conv-1', 'owner');
    await harness.owner.pool.query('ALTER TABLE conversation_handoffs ENABLE TRIGGER w2d_fail_audit');
    await assert.rejects(repo.resolveHumanHandoff('org-A', 'conv-1', 'owner', 'RETURN_TO_AI'));
    row = await rawRow('org-A', 'conv-1');
    assert.deepEqual({ state: row.state, owner: row.handoff_owner_identity_id, key: row.booking_idempotency_key }, { state: 'HUMAN_ACTIVE', owner: 'owner', key: 'old-key' }, 'resolution rolled back');

    await harness.owner.pool.query('ALTER TABLE conversation_handoffs DISABLE TRIGGER w2d_fail_audit');
    await repo.resolveHumanHandoff('org-A', 'conv-1', 'owner', 'CLOSE');
    await harness.owner.pool.query('ALTER TABLE conversation_handoffs ENABLE TRIGGER w2d_fail_audit');
    await assert.rejects(repo.reopenClosedConversation('org-A', 'conv-1', 'svc-chan-1'));
    row = await rawRow('org-A', 'conv-1');
    assert.equal(row.state, 'CLOSED', 'reopen rolled back');
    assert.equal(await eventCount(), 2, 'exactly the two events whose transitions committed');
  } finally {
    await harness.owner.pool.query('DROP TRIGGER IF EXISTS w2d_fail_audit ON conversation_handoffs');
    await harness.owner.pool.query('DROP FUNCTION IF EXISTS w2d_fail_audit()');
  }
});

test('RLS: org B can neither see nor write org A handoff history; no context sees nothing', async () => {
  await seedHandoff();
  await seedHandoff({ organizationId: 'org-B' });
  await repo.claimHumanHandoff('org-A', 'conv-1', 'owner-a');
  assert.deepEqual(await repo.listHandoffEvents('org-B', 'conv-1'), []);
  const seenByB = await withOrganizationContext(harness.app.db, 'org-B', (tx) => tx.select().from(conversationHandoffs));
  assert.deepEqual(seenByB, []);
  const noContext = await harness.app.pool.query('select count(*)::int as n from conversation_handoffs');
  assert.equal(noContext.rows[0].n, 0);
  await assert.rejects(
    withOrganizationContext(harness.app.db, 'org-B', (tx) =>
      tx.insert(conversationHandoffs).values({ organizationId: 'org-A', handoffId: 'spoof', conversationId: 'conv-1', eventType: 'CLAIMED', actorIdentityId: 'x', actorPrincipalType: 'human' }),
    ),
    (e: unknown) => pgErrorCode(e) === '42501',
  );
  // org B's own claim path cannot touch org A's conversation either.
  assert.equal((await repo.claimHumanHandoff('org-B', 'conv-1', 'owner-b')).kind, 'CLAIMED');
  assert.equal((await rawRow('org-A', 'conv-1')).handoff_owner_identity_id, 'owner-a');
});

test('append-only: the runtime role cannot UPDATE or DELETE handoff rows (42501); the trigger blocks even the owner (P0001)', async () => {
  await seedHandoff();
  await repo.claimHumanHandoff('org-A', 'conv-1', 'owner');
  for (const statement of [`update conversation_handoffs set actor_identity_id = 'forged'`, 'delete from conversation_handoffs']) {
    await assert.rejects(
      withOrganizationContext(harness.app.db, 'org-A', (tx) => tx.execute(statement as never)),
      (e: unknown) => pgErrorCode(e) === '42501',
      statement,
    );
  }
  await assert.rejects(harness.owner.pool.query(`update conversation_handoffs set actor_identity_id = 'forged'`), (e: { code?: string }) => e.code === 'P0001');
  await assert.rejects(harness.owner.pool.query('delete from conversation_handoffs'), (e: { code?: string }) => e.code === 'P0001');
  assert.equal(await eventCount(), 1);
});

test('CHECK: an owner can exist only while HUMAN_ACTIVE, and HUMAN_ACTIVE always has one (23514)', async () => {
  await seedHandoff();
  const bad = [
    { state: 'AI_ACTIVE', handoffOwnerIdentityId: 'x', handoffClaimedAt: new Date() },
    { state: 'HUMAN_ACTIVE' },
    { state: 'HUMAN_ACTIVE', handoffOwnerIdentityId: 'x' },
  ];
  for (const set of bad) {
    await assert.rejects(
      withOrganizationContext(harness.app.db, 'org-A', (tx) => tx.update(conversations).set(set as never)),
      (e: unknown) => pgErrorCode(e) === '23514',
      JSON.stringify(set),
    );
  }
});

test('handoff event CHECKs: RESOLVED needs an outcome, REOPENED must be a service actor, staff events must be human (23514)', async () => {
  await seedHandoff();
  const rows = [
    { eventType: 'RESOLVED', actorPrincipalType: 'human' },
    { eventType: 'CLAIMED', actorPrincipalType: 'human', outcome: 'CLOSE' },
    { eventType: 'REOPENED', actorPrincipalType: 'human' },
    { eventType: 'CLAIMED', actorPrincipalType: 'service' },
  ];
  for (const [i, row] of rows.entries()) {
    await assert.rejects(
      withOrganizationContext(harness.app.db, 'org-A', (tx) => tx.insert(conversationHandoffs).values({ organizationId: 'org-A', handoffId: `h-${i}`, conversationId: 'conv-1', actorIdentityId: 'x', ...row })),
      (e: unknown) => pgErrorCode(e) === '23514',
      JSON.stringify(row),
    );
  }
});
