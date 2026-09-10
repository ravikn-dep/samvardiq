import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { sql } from 'drizzle-orm';

import { pgErrorCode } from '../../src/postgres/client.js';
import { PostgresIdentityAuditRepository } from '../../src/postgres/identityAuditRepository.js';
import { startHarness, type Harness } from './harness.js';

/**
 * M, N, O, P, Q, R of the IDENTITY-W6 adversarial matrix — append-only
 * enforcement, RLS scope isolation, and the "no fake immutability" claim,
 * proven against real, disposable PostgreSQL (never mocked — section 36).
 */

const PORT = 55434;
let harness: Harness;
let auditApp: PostgresIdentityAuditRepository;

before(async () => {
  harness = await startHarness(PORT);
  auditApp = new PostgresIdentityAuditRepository(harness.app.db);
}, { timeout: 60_000 });

after(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.truncateAll();
});

async function createIdentity(identityId: string): Promise<void> {
  await harness.owner.pool.query(
    `insert into identities (identity_id, principal_type, display_name, status) values ($1, 'human', $1, 'active')`,
    [identityId],
  );
}

async function seedOrgAEvent(): Promise<string> {
  await createIdentity('id-actor');
  const event = await auditApp.append({
    organizationId: 'org-A',
    actor: { principalType: 'human', identityId: 'id-actor' },
    eventType: 'MEMBERSHIP_STATUS_CHANGED',
    targetType: 'MEMBERSHIP',
    targetId: 'org-A::id-target',
    outcome: 'SUCCESS',
  });
  return event.eventId;
}

test('O: append succeeds under the authorized persistence path — both organization-scoped and global events', async () => {
  const orgEvent = await seedOrgAEvent();
  assert.ok(orgEvent);

  const globalEvent = await auditApp.append({
    actor: { principalType: 'system' },
    eventType: 'IDENTITY_CREATED',
    targetType: 'IDENTITY',
    targetId: 'id-new',
    outcome: 'SUCCESS',
  });
  assert.equal(globalEvent.organizationId, undefined);

  assert.equal((await auditApp.listByOrganization('org-A')).length, 1);
  assert.equal((await auditApp.listGlobal()).length, 1);
});

test('P: organization A cannot read organization B\'s audit events via RLS', async () => {
  await seedOrgAEvent();
  await createIdentity('id-actor-b');
  await auditApp.append({
    organizationId: 'org-B',
    actor: { principalType: 'human', identityId: 'id-actor-b' },
    eventType: 'MEMBERSHIP_STATUS_CHANGED',
    targetType: 'MEMBERSHIP',
    targetId: 'org-B::id-target-b',
    outcome: 'SUCCESS',
  });

  const orgAEvents = await auditApp.listByOrganization('org-A');
  const orgBEvents = await auditApp.listByOrganization('org-B');
  assert.equal(orgAEvents.length, 1);
  assert.equal(orgBEvents.length, 1);
  assert.notEqual(orgAEvents[0]!.eventId, orgBEvents[0]!.eventId);
});

test('Q: an INSERT claiming a different organization than the session\'s own scoped context is rejected by RLS', async () => {
  await createIdentity('id-attacker');
  let caught: unknown;
  try {
    await harness.app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org-A', true)`);
      // A MEMBERSHIP-type event (organization_id required NOT NULL either way) claiming org-B
      // while the session's own scope is org-A — isolates the RLS WITH CHECK violation from
      // the (unrelated) organization_scope_check constraint that governs IDENTITY_*/PROVIDER_LINK_* types.
      await tx.execute(
        sql`insert into identity_audit_events (event_id, organization_id, actor_principal_type, actor_identity_id, event_type, target_type, target_id, outcome)
            values ('evt-spoof', 'org-B', 'human', 'id-attacker', 'MEMBERSHIP_STATUS_CHANGED', 'MEMBERSHIP', 'org-B::id-target', 'SUCCESS')`,
      );
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'an insert claiming org-B while the session context is org-A must fail');
  assert.equal(pgErrorCode(caught), '42501', 'rejected by the RLS WITH CHECK policy — insufficient privilege to write outside the session\'s own organization scope');
});

test('R: a global (null-organization) event is never visible under any tenant organization context', async () => {
  await auditApp.append({
    actor: { principalType: 'system' },
    eventType: 'IDENTITY_CREATED',
    targetType: 'IDENTITY',
    targetId: 'id-global',
    outcome: 'SUCCESS',
  });
  await seedOrgAEvent();

  // Under org-A's own context, only org-A's row is visible — the global row must not leak in.
  const orgAEvents = await auditApp.listByOrganization('org-A');
  assert.equal(orgAEvents.length, 1);
  assert.equal(orgAEvents[0]!.eventType, 'MEMBERSHIP_STATUS_CHANGED');

  // With NO tenant context set at all, only the global row is visible — org-A's row must not leak out.
  const globalEvents = await auditApp.listGlobal();
  assert.equal(globalEvents.length, 1);
  assert.equal(globalEvents[0]!.eventType, 'IDENTITY_CREATED');
});

test('M: a direct UPDATE under samvardiq_app is denied (no UPDATE privilege granted)', async () => {
  await seedOrgAEvent();
  let caught: unknown;
  try {
    await harness.app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org-A', true)`);
      await tx.execute(sql`update identity_audit_events set outcome = 'FAILED' where organization_id = 'org-A'`);
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(pgErrorCode(caught), '42501', 'permission denied — no UPDATE grant on identity_audit_events');
});

test('M (owner role): the immutability trigger blocks UPDATE even for the privileged owner role', async () => {
  await harness.owner.pool.query(
    `insert into identity_audit_events (event_id, organization_id, actor_principal_type, actor_identity_id, event_type, target_type, target_id, outcome)
     values ('evt-owner-m', null, 'system', null, 'IDENTITY_CREATED', 'IDENTITY', 'id-x', 'SUCCESS')`,
  );
  let caught: unknown;
  try {
    await harness.owner.pool.query(`update identity_audit_events set outcome = 'FAILED' where event_id = 'evt-owner-m'`);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'the owner role must still be blocked by the immutability trigger');
  assert.match(String((caught as Error).message), /immutable and cannot be updated or deleted/);
});

test('N: a direct DELETE under samvardiq_app is denied (no DELETE privilege granted)', async () => {
  await seedOrgAEvent();
  let caught: unknown;
  try {
    await harness.app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org-A', true)`);
      await tx.execute(sql`delete from identity_audit_events where organization_id = 'org-A'`);
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(pgErrorCode(caught), '42501', 'permission denied — no DELETE grant on identity_audit_events');
});

test('N (owner role): the immutability trigger blocks DELETE even for the privileged owner role', async () => {
  await harness.owner.pool.query(
    `insert into identity_audit_events (event_id, organization_id, actor_principal_type, actor_identity_id, event_type, target_type, target_id, outcome)
     values ('evt-owner-n', null, 'system', null, 'IDENTITY_CREATED', 'IDENTITY', 'id-x', 'SUCCESS')`,
  );
  let caught: unknown;
  try {
    await harness.owner.pool.query(`delete from identity_audit_events where event_id = 'evt-owner-n'`);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'the owner role must still be blocked by the immutability trigger');
  assert.match(String((caught as Error).message), /immutable and cannot be updated or deleted/);
});

test('AO: database-owner capability is described accurately — the owner CAN still DROP the trigger itself (DDL), which is why this is called "application-immutable / append-only under the runtime role," never absolute immutability', async () => {
  await harness.owner.pool.query(`ALTER TABLE identity_audit_events DISABLE TRIGGER identity_audit_events_immutable`);
  await harness.owner.pool.query(
    `insert into identity_audit_events (event_id, organization_id, actor_principal_type, actor_identity_id, event_type, target_type, target_id, outcome)
     values ('evt-owner-ao', null, 'system', null, 'IDENTITY_CREATED', 'IDENTITY', 'id-x', 'SUCCESS')`,
  );
  // With the trigger disabled by a superuser/owner, an UPDATE now succeeds — proving the guarantee is
  // scoped to "the application's own runtime access path" (samvardiq_app + the trigger), not an
  // unconditional database-level impossibility, exactly as documented in the migration file.
  await harness.owner.pool.query(`update identity_audit_events set outcome = 'FAILED' where event_id = 'evt-owner-ao'`);
  const { rows } = await harness.owner.pool.query(`select outcome from identity_audit_events where event_id = 'evt-owner-ao'`);
  assert.equal(rows[0].outcome, 'FAILED');
  // Restore the trigger for any subsequent test in this file.
  await harness.owner.pool.query(`ALTER TABLE identity_audit_events ENABLE TRIGGER identity_audit_events_immutable`);
});
