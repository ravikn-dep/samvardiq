import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import {
  DuplicateEntityError,
  InvalidMembershipTransitionError,
  LastActiveOwnerViolationError,
  MembershipAdministrationForbiddenError,
  MembershipNotFoundError,
  TargetIdentityUnavailableError,
} from '../../src/errors.js';
import { PostgresIdentityAuditRepository } from '../../src/postgres/identityAuditRepository.js';
import { PostgresIdentityRepository } from '../../src/postgres/identityRepository.js';
import { PostgresMembershipAdministrationService } from '../../src/postgres/membershipAdministrationService.js';
import { PostgresMembershipRepository } from '../../src/postgres/membershipRepository.js';
import type { OrganizationRole, TrustedOrganizationContext } from '../../src/types.js';
import { startHarness, type Harness } from './harness.js';

/**
 * The bulk of the IDENTITY-W7 adversarial matrix (A-C, D, I, N-Z, AA-AI,
 * AJ-AO, AQ-AS, AU) proven against real PostgreSQL — real transactions,
 * real row locking, real RLS. Never mocks the boundary being claimed
 * (section 32).
 */

const PORT = 55436;
let harness: Harness;
let service: PostgresMembershipAdministrationService;
let identities: PostgresIdentityRepository;
let memberships: PostgresMembershipRepository;
let auditRepo: PostgresIdentityAuditRepository;

before(async () => {
  harness = await startHarness(PORT);
  identities = new PostgresIdentityRepository(harness.app.db);
  memberships = new PostgresMembershipRepository(harness.app.db);
  auditRepo = new PostgresIdentityAuditRepository(harness.app.db);
  service = new PostgresMembershipAdministrationService(harness.app.db, identities);
}, { timeout: 60_000 });

after(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.truncateAll();
});

async function createIdentity(identityId: string, status: 'active' | 'suspended' | 'revoked' = 'active'): Promise<void> {
  await harness.owner.pool.query(
    `insert into identities (identity_id, principal_type, display_name, status) values ($1, 'human', $1, $2)`,
    [identityId, status],
  );
}

async function seedMembership(
  organizationId: string,
  identityId: string,
  role: OrganizationRole,
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' = 'ACTIVE',
): Promise<void> {
  await harness.owner.pool.query(
    `insert into organization_memberships (organization_id, identity_id, role, status) values ($1, $2, $3, $4)`,
    [organizationId, identityId, role, status],
  );
}

async function seedOwner(organizationId: string, identityId: string): Promise<void> {
  await createIdentity(identityId);
  await seedMembership(organizationId, identityId, 'OWNER', 'ACTIVE');
}

function actor(overrides: Partial<TrustedOrganizationContext> = {}): TrustedOrganizationContext {
  return {
    identityId: 'owner-1',
    organizationId: 'org-A',
    membershipId: 'org-A::owner-1',
    role: 'OWNER',
    principalType: 'human',
    establishedAt: new Date().toISOString(),
    ...overrides,
  };
}

// --- A/B/C: policy enforcement -------------------------------------------

test('A: an OWNER may create an invited membership', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');

  const membership = await service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' });
  assert.equal(membership.status, 'INVITED');
  assert.equal(membership.role, 'MEMBER');
});

test('B: a MEMBER cannot administer memberships', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('member-1');
  await seedMembership('org-A', 'member-1', 'MEMBER', 'ACTIVE');
  await createIdentity('target-1');

  await assert.rejects(
    service.createInvitedMembership(actor({ identityId: 'member-1', role: 'MEMBER' }), { targetIdentityId: 'target-1', role: 'MEMBER' }),
    MembershipAdministrationForbiddenError,
  );
});

test('C: a VIEWER cannot administer memberships', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('viewer-1');
  await seedMembership('org-A', 'viewer-1', 'VIEWER', 'ACTIVE');
  await createIdentity('target-1');

  await assert.rejects(
    service.createInvitedMembership(actor({ identityId: 'viewer-1', role: 'VIEWER' }), { targetIdentityId: 'target-1', role: 'MEMBER' }),
    MembershipAdministrationForbiddenError,
  );
});

test('AU: a service-principal OWNER cannot administer (human-only route)', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await assert.rejects(
    service.createInvitedMembership(actor({ principalType: 'service' }), { targetIdentityId: 'target-1', role: 'MEMBER' }),
    MembershipAdministrationForbiddenError,
  );
});

// --- I: cross-org isolation ------------------------------------------------

test('I: an Org A OWNER cannot administer an Org B membership (non-enumerating denial)', async () => {
  await seedOwner('org-A', 'owner-1');
  await seedOwner('org-B', 'owner-2');
  await createIdentity('target-b');
  await seedMembership('org-B', 'target-b', 'MEMBER', 'ACTIVE');

  // org-A's own OWNER attempts to suspend a membership that only exists in org-B.
  await assert.rejects(service.suspendMembership(actor({ identityId: 'owner-1', organizationId: 'org-A' }), 'target-b'), MembershipNotFoundError);
});

// --- N/O/P: target identity eligibility -----------------------------------

test('N: a valid (active) target identity can receive a permitted membership', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1', 'active');
  const membership = await service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'VIEWER' });
  assert.equal(membership.role, 'VIEWER');
});

test('O: a suspended target identity is rejected at membership creation', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1', 'suspended');
  await assert.rejects(
    service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' }),
    TargetIdentityUnavailableError,
  );
});

test('P: a revoked target identity is rejected at membership creation', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1', 'revoked');
  await assert.rejects(
    service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' }),
    TargetIdentityUnavailableError,
  );
});

test('a nonexistent target identity is rejected the same way as a suspended/revoked one (non-enumerable)', async () => {
  await seedOwner('org-A', 'owner-1');
  await assert.rejects(
    service.createInvitedMembership(actor(), { targetIdentityId: 'does-not-exist', role: 'MEMBER' }),
    TargetIdentityUnavailableError,
  );
});

// --- Q: duplicate membership -----------------------------------------------

test('Q: a duplicate membership is rejected safely, without leaking SQL/constraint detail', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' });

  await assert.rejects(
    service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'VIEWER' }),
    (error: unknown) => {
      assert.ok(error instanceof DuplicateEntityError);
      assert.ok(!String((error as Error).message).match(/pkey|constraint|sql|23505/i));
      return true;
    },
  );
});

// --- T/U: invalid transitions -----------------------------------------------

test('T: an invalid lifecycle transition (suspend an INVITED membership) is rejected', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' });

  await assert.rejects(service.suspendMembership(actor(), 'target-1'), InvalidMembershipTransitionError);
});

test('U: REVOKED resurrection is rejected — reactivate/activate after revoke fails', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' });
  await service.revokeMembership(actor(), 'target-1');

  await assert.rejects(service.activateMembership(actor(), 'target-1'), InvalidMembershipTransitionError);
  await assert.rejects(service.reactivateMembership(actor(), 'target-1'), InvalidMembershipTransitionError);
});

// --- V-AA: lifecycle + atomic audit -----------------------------------------

test('V: membership creation produces an atomic MEMBERSHIP_CREATED audit event', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  const membership = await service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' });

  const events = await auditRepo.listByOrganization('org-A');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventType, 'MEMBERSHIP_CREATED');
  assert.equal(events[0]!.outcome, 'SUCCESS');
  assert.equal(events[0]!.targetId, 'org-A::target-1');
  assert.deepEqual(events[0]!.metadata, { toRole: 'MEMBER' });
  assert.equal(membership.identityId, 'target-1');
});

test('W: activation produces an atomic status-change audit event', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' });

  const membership = await service.activateMembership(actor(), 'target-1');
  assert.equal(membership.status, 'ACTIVE');

  const events = await auditRepo.listByOrganization('org-A');
  const activation = events.find((e) => e.eventType === 'MEMBERSHIP_STATUS_CHANGED');
  assert.deepEqual(activation?.metadata, { fromStatus: 'INVITED', toStatus: 'ACTIVE' });
});

test('X: suspension produces an atomic status-change audit event', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'ACTIVE');

  await service.suspendMembership(actor(), 'target-1');
  const events = await auditRepo.listByOrganization('org-A');
  const found = events.find((e) => e.eventType === 'MEMBERSHIP_STATUS_CHANGED');
  assert.deepEqual(found?.metadata, { fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' });
});

test('Y: reactivation produces an atomic status-change audit event', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'SUSPENDED');

  await service.reactivateMembership(actor(), 'target-1');
  const events = await auditRepo.listByOrganization('org-A');
  const found = events.find((e) => e.eventType === 'MEMBERSHIP_STATUS_CHANGED');
  assert.deepEqual(found?.metadata, { fromStatus: 'SUSPENDED', toStatus: 'ACTIVE' });
});

test('Z: revocation produces an atomic status-change audit event', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'ACTIVE');

  await service.revokeMembership(actor(), 'target-1');
  const events = await auditRepo.listByOrganization('org-A');
  const found = events.find((e) => e.eventType === 'MEMBERSHIP_STATUS_CHANGED');
  assert.deepEqual(found?.metadata, { fromStatus: 'ACTIVE', toStatus: 'REVOKED' });
});

test('AA: role change produces an atomic MEMBERSHIP_ROLE_CHANGED audit event', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'ACTIVE');

  const updated = await service.changeRole(actor(), 'target-1', 'VIEWER');
  assert.equal(updated.role, 'VIEWER');

  const events = await auditRepo.listByOrganization('org-A');
  const found = events.find((e) => e.eventType === 'MEMBERSHIP_ROLE_CHANGED');
  assert.deepEqual(found?.metadata, { fromRole: 'MEMBER', toRole: 'VIEWER' });
});

// --- AB/AC: audit integrity --------------------------------------------------

test('AB/AC: audit actor and organization exactly match the trusted actor — never client-suppliable', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await service.createInvitedMembership(actor({ identityId: 'owner-1', organizationId: 'org-A' }), { targetIdentityId: 'target-1', role: 'MEMBER' });

  const events = await auditRepo.listByOrganization('org-A');
  assert.equal(events[0]!.organizationId, 'org-A');
  assert.deepEqual(events[0]!.actor, { principalType: 'human', identityId: 'owner-1' });
});

// --- AF/AG/AH/AI: audit failure rolls back mutation --------------------------

test('AF: an audit-insert failure (FK violation on an unknown actor identity) rolls back membership creation', async () => {
  await createIdentity('target-1');

  // The service trusts the TrustedOrganizationContext structurally (same
  // documented limitation as GoalReadService/TrustedOrganizationContext
  // elsewhere in this codebase) — it does not re-verify the actor has a
  // real membership row. This lets us prove the audit-atomicity guarantee
  // directly: 'owner-does-not-exist' passes the OWNER policy check (it
  // only inspects role/principalType) but does not exist as an
  // `identities` row, so the audit INSERT's FK constraint fails AFTER the
  // membership INSERT already ran in the same transaction.
  await assert.rejects(
    service.createInvitedMembership(actor({ identityId: 'owner-does-not-exist' }), { targetIdentityId: 'target-1', role: 'MEMBER' }),
  );

  const row = await memberships.get('org-A', 'target-1');
  assert.equal(row, undefined, 'the membership INSERT must be rolled back along with the failed audit INSERT');
  assert.equal((await auditRepo.listByOrganization('org-A')).length, 0);
});

test('AG: an audit-insert failure rolls back a status transition', async () => {
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'ACTIVE');

  await assert.rejects(service.suspendMembership(actor({ identityId: 'owner-does-not-exist' }), 'target-1'));

  const row = await memberships.get('org-A', 'target-1');
  assert.equal(row?.status, 'ACTIVE', 'the status UPDATE must be rolled back along with the failed audit INSERT');
  assert.equal((await auditRepo.listByOrganization('org-A')).length, 0);
});

test('AH: an audit-insert failure rolls back a role change', async () => {
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'ACTIVE');

  await assert.rejects(service.changeRole(actor({ identityId: 'owner-does-not-exist' }), 'target-1', 'VIEWER'));

  const row = await memberships.get('org-A', 'target-1');
  assert.equal(row?.role, 'MEMBER', 'the role UPDATE must be rolled back along with the failed audit INSERT');
  assert.equal((await auditRepo.listByOrganization('org-A')).length, 0);
});

test('AI: a rejected mutation (invalid transition) creates no SUCCESS audit event', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'REVOKED');

  await assert.rejects(service.suspendMembership(actor(), 'target-1'), InvalidMembershipTransitionError);
  assert.equal((await auditRepo.listByOrganization('org-A')).length, 0);
});

// --- AJ-AM: concurrency ------------------------------------------------------

test('AJ: two concurrent duplicate-membership creates result in at most one committed membership', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');

  const results = await Promise.allSettled([
    service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' }),
    service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'VIEWER' }),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 1);
  assert.ok((failed[0] as PromiseRejectedResult).reason instanceof DuplicateEntityError);
});

test('AK: concurrent activation attempts on the same invite produce exactly one success', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await service.createInvitedMembership(actor(), { targetIdentityId: 'target-1', role: 'MEMBER' });

  const results = await Promise.allSettled([service.activateMembership(actor(), 'target-1'), service.activateMembership(actor(), 'target-1')]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one concurrent activation may win');

  const events = (await auditRepo.listByOrganization('org-A')).filter((e) => e.eventType === 'MEMBERSHIP_STATUS_CHANGED');
  assert.equal(events.length, 1, 'no misleading duplicate success audit');
});

test('AL: two genuinely conflicting concurrent status changes (both expect ACTIVE) produce exactly one truthful committed audit', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'ACTIVE');

  // Both calls have the SAME precondition (expects ACTIVE) — the row lock
  // serializes them, the loser's re-read under lock sees the already-changed
  // status and correctly fails the precondition, rather than both applying.
  const results = await Promise.allSettled([service.suspendMembership(actor(), 'target-1'), service.suspendMembership(actor(), 'target-1')]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one of the two conflicting operations may win — the row lock serializes them');

  const finalRow = await memberships.get('org-A', 'target-1');
  const events = (await auditRepo.listByOrganization('org-A')).filter((e) => e.eventType === 'MEMBERSHIP_STATUS_CHANGED');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.metadata?.toStatus, finalRow?.status, 'the committed audit must match the actually-committed final state');
});

test('AM: two genuinely conflicting concurrent role changes (both expect the SAME fromRole/toRole pair) produce exactly one truthful committed audit', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await seedMembership('org-A', 'target-1', 'MEMBER', 'ACTIVE');

  // Both calls target the identical MEMBER -> VIEWER change — the loser's
  // re-read under lock sees fromRole already equal to toRole (VIEWER) and
  // is correctly rejected as a no-op, not silently re-applied.
  const results = await Promise.allSettled([
    service.changeRole(actor(), 'target-1', 'VIEWER'),
    service.changeRole(actor(), 'target-1', 'VIEWER'),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1);

  const finalRow = await memberships.get('org-A', 'target-1');
  const events = (await auditRepo.listByOrganization('org-A')).filter((e) => e.eventType === 'MEMBERSHIP_ROLE_CHANGED');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.metadata?.toRole, finalRow?.role);
});

// --- AN/AO/AQ/AR: last-owner protection --------------------------------------

test('AN: the last ACTIVE OWNER cannot be suspended, revoked, or downgraded', async () => {
  await seedOwner('org-A', 'owner-1');

  await assert.rejects(service.suspendMembership(actor(), 'owner-1'), LastActiveOwnerViolationError);
  await assert.rejects(service.revokeMembership(actor(), 'owner-1'), LastActiveOwnerViolationError);
  await assert.rejects(service.changeRole(actor(), 'owner-1', 'MEMBER'), LastActiveOwnerViolationError);
});

test('AP: a second OWNER permits the first OWNER\'s removal', async () => {
  await seedOwner('org-A', 'owner-1');
  await seedOwner('org-A', 'owner-2');

  const updated = await service.revokeMembership(actor({ identityId: 'owner-2' }), 'owner-1');
  assert.equal(updated.status, 'REVOKED');
});

test('AQ: self-revoke cannot orphan the organization (last owner)', async () => {
  await seedOwner('org-A', 'owner-1');
  await assert.rejects(service.revokeMembership(actor({ identityId: 'owner-1' }), 'owner-1'), LastActiveOwnerViolationError);
});

test('AR: self-downgrade cannot orphan the organization (last owner)', async () => {
  await seedOwner('org-A', 'owner-1');
  await assert.rejects(service.changeRole(actor({ identityId: 'owner-1' }), 'owner-1', 'MEMBER'), LastActiveOwnerViolationError);
});

test('self-revoke succeeds when another ACTIVE OWNER exists', async () => {
  await seedOwner('org-A', 'owner-1');
  await seedOwner('org-A', 'owner-2');
  const updated = await service.revokeMembership(actor({ identityId: 'owner-1' }), 'owner-1');
  assert.equal(updated.status, 'REVOKED');
});

test('AO: concurrent mutual last-owner removal attempts (Owner A suspending Owner B while Owner B suspends Owner A) cannot leave zero ACTIVE OWNERs, and does not deadlock', async () => {
  await seedOwner('org-A', 'owner-1');
  await seedOwner('org-A', 'owner-2');

  const results = await Promise.allSettled([
    service.suspendMembership(actor({ identityId: 'owner-1' }), 'owner-2'),
    service.suspendMembership(actor({ identityId: 'owner-2' }), 'owner-1'),
  ]);

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(succeeded.length, 1, 'exactly one of the two mutual removal attempts may succeed');
  assert.ok(failed[0]!.reason instanceof LastActiveOwnerViolationError, 'the second must be rejected as a last-owner violation, not a deadlock error');

  const row1 = await memberships.get('org-A', 'owner-1');
  const row2 = await memberships.get('org-A', 'owner-2');
  const activeOwnerCount = [row1, row2].filter((r) => r?.role === 'OWNER' && r?.status === 'ACTIVE').length;
  assert.equal(activeOwnerCount, 1, 'exactly one ACTIVE OWNER must remain — never zero');
});

// --- AS/AT: approval-authority separation ------------------------------------

test('AS/AT: a role change never touches approverRole — approval authority is a wholly separate system', async () => {
  await seedOwner('org-A', 'owner-1');
  await createIdentity('target-1');
  await harness.owner.pool.query(
    `insert into organization_memberships (organization_id, identity_id, role, status, approver_role) values ('org-A', 'target-1', 'MEMBER', 'ACTIVE', 'founder')`,
  );

  const updated = await service.changeRole(actor(), 'target-1', 'OWNER');
  assert.equal(updated.role, 'OWNER');
  assert.equal(updated.approverRole, 'founder', 'approverRole must be untouched by a membership role change — organization role and approval authority are separate systems');
});
