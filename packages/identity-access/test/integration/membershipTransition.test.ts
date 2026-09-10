import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { MembershipTransitionConcurrencyError } from '../../src/errors.js';
import { PostgresIdentityAuditRepository } from '../../src/postgres/identityAuditRepository.js';
import { PostgresMembershipTransitionCoordinator } from '../../src/postgres/membershipTransitionCoordinator.js';
import { PostgresMembershipRepository } from '../../src/postgres/membershipRepository.js';
import { startHarness, type Harness } from './harness.js';

/**
 * Z, AA, AB, AC, AD, AE, AF of the IDENTITY-W6 adversarial matrix — the
 * atomic mutation+audit proof, against real PostgreSQL (section 23/24/36).
 * Never mocks the transaction boundary being claimed.
 */

const PORT = 55435;
let harness: Harness;
let coordinator: PostgresMembershipTransitionCoordinator;
let memberships: PostgresMembershipRepository;
let auditRepo: PostgresIdentityAuditRepository;

before(async () => {
  harness = await startHarness(PORT);
  coordinator = new PostgresMembershipTransitionCoordinator(harness.app.db);
  memberships = new PostgresMembershipRepository(harness.app.db);
  auditRepo = new PostgresIdentityAuditRepository(harness.app.db);
}, { timeout: 60_000 });

after(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.truncateAll();
});

/** harness.owner connects as the Postgres superuser, which always bypasses RLS regardless of FORCE ROW LEVEL SECURITY — no org context needs to be set for this setup helper. */
async function seedMembership(organizationId: string, identityId: string, status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' = 'ACTIVE'): Promise<void> {
  await harness.owner.pool.query(
    `insert into identities (identity_id, principal_type, display_name, status) values ($1, 'human', $1, 'active')`,
    [identityId],
  );
  await harness.owner.pool.query(
    `insert into organization_memberships (organization_id, identity_id, role, status) values ($1, $2, 'MEMBER', $3)`,
    [organizationId, identityId, status],
  );
}

test('AB: a successful transition and its audit event commit atomically', async () => {
  await seedMembership('org-A', 'id-1', 'ACTIVE');

  const updated = await coordinator.transitionStatus({
    organizationId: 'org-A',
    identityId: 'id-1',
    expectedStatus: 'ACTIVE',
    nextStatus: 'SUSPENDED',
    actor: { principalType: 'human', identityId: 'id-1' },
    reason: 'administrator action',
  });
  assert.equal(updated.status, 'SUSPENDED');

  const membership = await memberships.get('org-A', 'id-1');
  assert.equal(membership?.status, 'SUSPENDED');

  const events = await auditRepo.listByOrganization('org-A');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventType, 'MEMBERSHIP_STATUS_CHANGED');
  assert.equal(events[0]!.outcome, 'SUCCESS');
  assert.equal(events[0]!.targetId, 'org-A::id-1');
  assert.deepEqual(events[0]!.metadata, { fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' });
});

test('AA/AC: a failed compare-and-swap (wrong expectedStatus) creates no SUCCESS audit event and leaves the membership unchanged', async () => {
  await seedMembership('org-A', 'id-1', 'ACTIVE');

  await assert.rejects(
    coordinator.transitionStatus({
      organizationId: 'org-A',
      identityId: 'id-1',
      expectedStatus: 'SUSPENDED', // wrong — it's actually ACTIVE
      nextStatus: 'REVOKED',
      actor: { principalType: 'human', identityId: 'id-1' },
    }),
    MembershipTransitionConcurrencyError,
  );

  const membership = await memberships.get('org-A', 'id-1');
  assert.equal(membership?.status, 'ACTIVE', 'the membership must remain in its original state — no partial mutation');

  const events = await auditRepo.listByOrganization('org-A');
  assert.equal(events.length, 0, 'no audit event of any kind for a mutation that never applied');
});

test('Z/AC: a mandatory audit insert failure (FK violation on an unknown actor) rolls back the mutation that already applied within the same transaction', async () => {
  await seedMembership('org-A', 'id-1', 'ACTIVE');

  await assert.rejects(
    coordinator.transitionStatus({
      organizationId: 'org-A',
      identityId: 'id-1',
      expectedStatus: 'ACTIVE',
      nextStatus: 'SUSPENDED',
      // This identity does not exist — the UPDATE above succeeds first (matches
      // the compare-and-swap), but the audit INSERT then fails on the real FK
      // constraint (identity_audit_events_actor_identity_fkey), proving a
      // genuine post-mutation audit failure rolls the whole transaction back.
      actor: { principalType: 'human', identityId: 'id-does-not-exist' },
    }),
  );

  const membership = await memberships.get('org-A', 'id-1');
  assert.equal(membership?.status, 'ACTIVE', 'the UPDATE must be rolled back along with the failed audit INSERT — no fail-open mutation');

  const events = await auditRepo.listByOrganization('org-A');
  assert.equal(events.length, 0, 'no audit event exists for a transaction that rolled back');
});

test('AD: concurrent transitions on DISTINCT memberships each produce their own distinct audit event', async () => {
  await seedMembership('org-A', 'id-1', 'ACTIVE');
  await seedMembership('org-A', 'id-2', 'ACTIVE');
  await seedMembership('org-A', 'id-3', 'ACTIVE');

  const results = await Promise.all(
    ['id-1', 'id-2', 'id-3'].map((identityId) =>
      coordinator.transitionStatus({
        organizationId: 'org-A',
        identityId,
        expectedStatus: 'ACTIVE',
        nextStatus: 'SUSPENDED',
        actor: { principalType: 'human', identityId },
      }),
    ),
  );
  assert.equal(results.length, 3);

  const events = await auditRepo.listByOrganization('org-A');
  assert.equal(events.length, 3);
  const eventIds = new Set(events.map((e) => e.eventId));
  assert.equal(eventIds.size, 3, 'every concurrent transition must produce a distinct event id');
});

test('AE: concurrent Org A / Org B transitions preserve audit isolation', async () => {
  await seedMembership('org-A', 'id-a', 'ACTIVE');
  await seedMembership('org-B', 'id-b', 'ACTIVE');

  await Promise.all([
    coordinator.transitionStatus({
      organizationId: 'org-A',
      identityId: 'id-a',
      expectedStatus: 'ACTIVE',
      nextStatus: 'SUSPENDED',
      actor: { principalType: 'human', identityId: 'id-a' },
    }),
    coordinator.transitionStatus({
      organizationId: 'org-B',
      identityId: 'id-b',
      expectedStatus: 'ACTIVE',
      nextStatus: 'SUSPENDED',
      actor: { principalType: 'human', identityId: 'id-b' },
    }),
  ]);

  const orgAEvents = await auditRepo.listByOrganization('org-A');
  const orgBEvents = await auditRepo.listByOrganization('org-B');
  assert.equal(orgAEvents.length, 1);
  assert.equal(orgBEvents.length, 1);
  assert.equal(orgAEvents[0]!.targetId, 'org-A::id-a');
  assert.equal(orgBEvents[0]!.targetId, 'org-B::id-b');
});

test('AF: concurrent mutation attempts on the SAME membership produce exactly one SUCCESS audit event, never a misleading duplicate', async () => {
  await seedMembership('org-A', 'id-1', 'ACTIVE');

  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      coordinator.transitionStatus({
        organizationId: 'org-A',
        identityId: 'id-1',
        expectedStatus: 'ACTIVE',
        nextStatus: 'SUSPENDED',
        actor: { principalType: 'human', identityId: 'id-1' },
      }),
    ),
  );

  const succeeded = attempts.filter((a) => a.status === 'fulfilled');
  const failed = attempts.filter((a) => a.status === 'rejected');
  assert.equal(succeeded.length, 1, 'exactly one concurrent attempt may win the compare-and-swap');
  assert.equal(failed.length, 9);
  for (const f of failed as PromiseRejectedResult[]) {
    assert.ok(f.reason instanceof MembershipTransitionConcurrencyError);
  }

  const events = await auditRepo.listByOrganization('org-A');
  assert.equal(events.length, 1, 'exactly one audit event — no duplicate or misleading SUCCESS record from a losing attempt');

  const membership = await memberships.get('org-A', 'id-1');
  assert.equal(membership?.status, 'SUSPENDED');
});
