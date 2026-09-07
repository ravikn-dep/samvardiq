import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { ApprovalGovernance, InMemoryApproverDirectory } from '@samvardiq/approval-governance';
import { sql } from 'drizzle-orm';

import { ApprovalRequestConcurrencyError, DuplicateEntityError, GoalNotFoundError, OrganizationNotFoundError, ReferentialIntegrityViolation } from '../../src/errors.js';
import { pgErrorCode } from '../../src/postgres/client.js';
import { PostgresApprovalRepository } from '../../src/postgres/approvalRepository.js';
import { PostgresGoalRepository } from '../../src/postgres/goalRepository.js';
import { PostgresOrganizationRepository } from '../../src/postgres/organizationRepository.js';
import { PostgresRecommendationRepository } from '../../src/postgres/recommendationRepository.js';
import type { PersistedRecommendation } from '../../src/types.js';
import { startHarness, type Harness } from './harness.js';

const PORT = 55432;
let harness: Harness;
let organizations: PostgresOrganizationRepository;
let goals: PostgresGoalRepository;
let recommendations: PostgresRecommendationRepository;
let approvals: PostgresApprovalRepository;

before(async () => {
  harness = await startHarness(PORT);
  organizations = new PostgresOrganizationRepository(harness.app.db);
  goals = new PostgresGoalRepository(harness.app.db);
  recommendations = new PostgresRecommendationRepository(harness.app.db);
  approvals = new PostgresApprovalRepository(harness.app.db);
}, { timeout: 60_000 });

after(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.truncateAll();
});

function sampleRecommendation(overrides: Partial<PersistedRecommendation> = {}): PersistedRecommendation {
  return {
    recommendationId: 'rec-1',
    organizationId: 'org-A',
    goalId: 'goal-1',
    owningExecutive: 'CMO',
    originatingSkill: 'healthcare-local-growth',
    title: 'Complete Google Business Profile information',
    status: 'Ready for Approval',
    approvalRequirement: 2,
    risk: 'low',
    evidenceReferences: [{ source: 'google_business_profile', description: 'profileCompleteness' }],
    confidence: 80,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function seedApprovableRecommendation(organizationId: string): Promise<PersistedRecommendation> {
  await organizations.create({ organizationId, organizationType: 'clinic', name: `Clinic ${organizationId}` });
  await goals.create({ goalId: 'goal-1', organizationId, title: 'Increase appointments', description: '...' });
  return recommendations.save(sampleRecommendation({ organizationId, goalId: 'goal-1' }));
}

// A — migration from empty database
test('A: migration establishes all 5 tables', async () => {
  const rows = await harness.owner.pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  assert.deepEqual(
    rows.rows.map((r: { table_name: string }) => r.table_name),
    ['approval_records', 'approval_requests', 'goals', 'organizations', 'recommendations'],
  );
});

// B — organization create/read
test('B: organization create/read round-trips through real Postgres', async () => {
  const org = await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  assert.equal(org.status, 'active');
  const fetched = await organizations.get('org-A');
  assert.equal(fetched?.name, 'Clinic A');
  assert.equal(await organizations.get('org-missing'), undefined);
});

// C — goal FK integrity
test('C: goal creation fails closed when organization does not exist', async () => {
  await assert.rejects(
    goals.create({ goalId: 'goal-1', organizationId: 'org-missing', title: 'Increase appointments', description: '...' }),
    OrganizationNotFoundError,
  );
});

// D — recommendation organization integrity
test('D: recommendation save fails closed across organizations', async () => {
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'Clinic B' });
  await goals.create({ goalId: 'goal-1', organizationId: 'org-A', title: 'Increase appointments', description: '...' });

  await assert.rejects(
    recommendations.save(sampleRecommendation({ organizationId: 'org-B', goalId: 'goal-1' })),
    GoalNotFoundError,
  );
});

// E — ApprovalRequest integrity
test('E: approval request save fails closed when the recommendation does not exist', async () => {
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await assert.rejects(
    approvals.saveRequest({
      approvalRequestId: 'req-1',
      organizationId: 'org-A',
      goalId: 'goal-1',
      recommendationId: 'rec-missing',
      requestedBy: 'CMO',
      requiredApprovalLevel: 2,
      risk: 'low',
      reason: 'test',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    }),
    ReferentialIntegrityViolation,
  );
});

// F — ApprovalRecord integrity
test('F: approval record insert fails closed when the approval request does not exist', async () => {
  await assert.rejects(
    approvals.appendRecord(
      Object.freeze({
        approvalRecordId: 'audit-1',
        approvalRequestId: 'req-missing',
        organizationId: 'org-A',
        goalId: 'goal-1',
        recommendationId: 'rec-1',
        requiredApprovalLevel: 2,
        decision: 'APPROVED',
        approverId: 'founder',
        approverRole: 'founder',
        rationale: undefined,
        requestedAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
        previousState: 'PENDING',
        resultingState: 'APPROVED',
      }),
    ),
    ReferentialIntegrityViolation,
  );
});

// G — org-A cannot read org-B
test('G: organization A cannot read organization B\'s rows via RLS', async () => {
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'Clinic B' });
  await goals.create({ goalId: 'goal-1', organizationId: 'org-B', title: 'Org B goal', description: '...' });

  assert.equal(await goals.get('org-A', 'goal-1'), undefined, 'the repository itself must not surface org-B\'s goal to org-A');

  await harness.app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', 'org-A', true)`);
    const rows = await tx.execute(sql`select * from goals`);
    assert.equal(rows.rows.length, 0, 'org-A context must not see any of org-B\'s rows, even with an unscoped SELECT *');
  });
});

// H — org-A cannot write org-B
test('H: organization A cannot insert a row claiming to belong to organization B', async () => {
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'Clinic B' });

  let caught: unknown;
  try {
    await harness.app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org-A', true)`);
      await tx.execute(
        sql`insert into goals (organization_id, goal_id, title, description, status) values ('org-B', 'sneaky-goal', 'x', 'y', 'active')`,
      );
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'the spoofed cross-organization insert must fail');
  assert.equal(pgErrorCode(caught), '42501', 'must be an RLS policy violation (insufficient_privilege)');

  assert.equal(await goals.get('org-B', 'sneaky-goal'), undefined, 'the spoofed insert must not have persisted');
});

// I — missing organization context fails closed
test('I: missing organization context fails closed for both read and write', async () => {
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await goals.create({ goalId: 'goal-1', organizationId: 'org-A', title: 'Org A goal', description: '...' });

  const readRows = await harness.app.pool.query('select * from goals');
  assert.equal(readRows.rows.length, 0, 'missing context must not expose any tenant rows on read');

  let caught: unknown;
  try {
    await harness.app.pool.query(
      `insert into goals (organization_id, goal_id, title, description, status) values ('org-A', 'no-context-goal', 'x', 'y', 'active')`,
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'missing context must not permit a write either');
  assert.equal(pgErrorCode(caught), '42501');
});

// J — spoofed organization_id fails
test('J: a WHERE clause claiming an organization_id does not bypass RLS without real session context', async () => {
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await goals.create({ goalId: 'goal-1', organizationId: 'org-A', title: 'Org A goal', description: '...' });

  const rows = await harness.app.pool.query(`select * from goals where organization_id = 'org-A'`);
  assert.equal(rows.rows.length, 0, 'an explicit WHERE organization_id claim must not substitute for real session context');
});

// K — valid approval transaction commits request + record
test('K: a valid approval transaction commits both the request transition and the record atomically', async () => {
  const rec = await seedApprovableRecommendation('org-K');
  const directory = new InMemoryApproverDirectory();
  directory.register({ id: 'founder-k', organizationId: 'org-K', role: 'founder', kind: 'human' });
  const governance = new ApprovalGovernance(approvals, directory);

  const request = await governance.submitApprovalRequest({
    organizationId: 'org-K',
    goalId: 'goal-1',
    recommendationId: rec.recommendationId,
    requestedBy: 'CMO',
    recommendation: {
      recommendationId: rec.recommendationId,
      organizationId: 'org-K',
      goalId: 'goal-1',
      approvalRequirement: rec.approvalRequirement,
      risk: rec.risk,
      title: rec.title,
    },
  });
  const record = await governance.decide(request.approvalRequestId, {
    decision: 'APPROVED',
    approverId: 'founder-k',
    organizationId: 'org-K',
  });

  assert.equal(record.decision, 'APPROVED');
  const persistedRequest = await approvals.getRequest('org-K', request.approvalRequestId);
  assert.equal(persistedRequest?.status, 'APPROVED');
  const persistedRecords = await approvals.listRecords('org-K', request.approvalRequestId);
  assert.equal(persistedRecords.length, 1);
  assert.equal(persistedRecords[0]?.decision, 'APPROVED');
});

// L — induced failure rolls back BOTH request transition and record
test('L: an induced mid-transaction failure rolls back both the request transition and the record', async () => {
  const rec = await seedApprovableRecommendation('org-L');
  await approvals.saveRequest({
    approvalRequestId: 'req-L',
    organizationId: 'org-L',
    goalId: 'goal-1',
    recommendationId: rec.recommendationId,
    requestedBy: 'CMO',
    requiredApprovalLevel: 2,
    risk: 'low',
    reason: 'test',
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  });

  let caught: unknown;
  try {
    await harness.app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org-L', true)`);
      await tx.execute(
        sql`update approval_requests set status = 'APPROVED', decided_at = now() where organization_id = 'org-L' and approval_request_id = 'req-L' and status = 'PENDING'`,
      );
      // Deliberately violate the decision CHECK constraint to force the transaction to fail after the UPDATE.
      await tx.execute(
        sql`insert into approval_records (organization_id, approval_record_id, approval_request_id, goal_id, recommendation_id, required_approval_level, decision, approver_id, approver_role, requested_at, decided_at, previous_state, resulting_state) values ('org-L', 'audit-L', 'req-L', 'goal-1', ${rec.recommendationId}, 2, 'NOT_A_REAL_DECISION', 'founder', 'founder', now(), now(), 'PENDING', 'APPROVED')`,
      );
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'the deliberately invalid INSERT must fail');

  const request = await approvals.getRequest('org-L', 'req-L');
  assert.equal(request?.status, 'PENDING', 'the UPDATE must have rolled back along with the failed INSERT');
  const records = await approvals.listRecords('org-L', 'req-L');
  assert.equal(records.length, 0, 'no partial record may exist after rollback');
});

// M — concurrent double-decision produces exactly one terminal record
test('M: concurrent double-decision produces exactly one terminal record', async () => {
  const rec = await seedApprovableRecommendation('org-M');
  await approvals.saveRequest({
    approvalRequestId: 'req-M',
    organizationId: 'org-M',
    goalId: 'goal-1',
    recommendationId: rec.recommendationId,
    requestedBy: 'CMO',
    requiredApprovalLevel: 2,
    risk: 'low',
    reason: 'test',
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  });
  const baseRequest = await approvals.getRequest('org-M', 'req-M');
  assert.ok(baseRequest);

  function makeRecord(decision: 'APPROVED' | 'REJECTED', suffix: string) {
    return Object.freeze({
      approvalRecordId: `audit-M-${suffix}`,
      approvalRequestId: 'req-M',
      organizationId: 'org-M',
      goalId: 'goal-1',
      recommendationId: rec.recommendationId,
      requiredApprovalLevel: 2,
      decision,
      approverId: `approver-${suffix}`,
      approverRole: 'founder' as const,
      rationale: undefined,
      requestedAt: baseRequest!.createdAt,
      decidedAt: new Date().toISOString(),
      previousState: 'PENDING' as const,
      resultingState: decision,
    });
  }

  const results = await Promise.allSettled([
    approvals.recordDecision({ ...baseRequest!, status: 'APPROVED', decidedAt: new Date().toISOString() }, makeRecord('APPROVED', 'a')),
    approvals.recordDecision({ ...baseRequest!, status: 'REJECTED', decidedAt: new Date().toISOString() }, makeRecord('REJECTED', 'b')),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejectedOutcomes = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent decision must succeed');
  assert.equal(rejectedOutcomes.length, 1, 'exactly one concurrent decision must fail deterministically');
  assert.ok(rejectedOutcomes[0]!.reason instanceof ApprovalRequestConcurrencyError);

  const records = await approvals.listRecords('org-M', 'req-M');
  assert.equal(records.length, 1, 'exactly one terminal ApprovalRecord may exist');

  const finalRequest = await approvals.getRequest('org-M', 'req-M');
  assert.notEqual(finalRequest?.status, 'PENDING');
});

// N — ApprovalRecord UPDATE rejected
test('N: ApprovalRecord UPDATE is rejected for the application role (permission denied)', async () => {
  const rec = await seedApprovableRecommendation('org-N');
  await approvals.saveRequest({
    approvalRequestId: 'req-N', organizationId: 'org-N', goalId: 'goal-1', recommendationId: rec.recommendationId,
    requestedBy: 'CMO', requiredApprovalLevel: 2, risk: 'low', reason: 'test', status: 'PENDING', createdAt: new Date().toISOString(),
  });
  await approvals.appendRecord(
    Object.freeze({
      approvalRecordId: 'audit-N', approvalRequestId: 'req-N', organizationId: 'org-N', goalId: 'goal-1',
      recommendationId: rec.recommendationId, requiredApprovalLevel: 2, decision: 'APPROVED', approverId: 'founder',
      approverRole: 'founder', rationale: undefined, requestedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      previousState: 'PENDING', resultingState: 'APPROVED',
    }),
  );

  let caught: unknown;
  try {
    await harness.app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org-N', true)`);
      await tx.execute(sql`update approval_records set decision = 'REJECTED' where organization_id = 'org-N' and approval_record_id = 'audit-N'`);
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(pgErrorCode(caught), '42501', 'samvardiq_app has no UPDATE grant on approval_records');

  const stillApproved = await approvals.listRecords('org-N', 'req-N');
  assert.equal(stillApproved[0]?.decision, 'APPROVED');
});

test('N (owner role): the immutability trigger blocks UPDATE even for the privileged owner role', async () => {
  const rec = await seedApprovableRecommendation('org-N2');
  await approvals.saveRequest({
    approvalRequestId: 'req-N2', organizationId: 'org-N2', goalId: 'goal-1', recommendationId: rec.recommendationId,
    requestedBy: 'CMO', requiredApprovalLevel: 2, risk: 'low', reason: 'test', status: 'PENDING', createdAt: new Date().toISOString(),
  });
  await approvals.appendRecord(
    Object.freeze({
      approvalRecordId: 'audit-N2', approvalRequestId: 'req-N2', organizationId: 'org-N2', goalId: 'goal-1',
      recommendationId: rec.recommendationId, requiredApprovalLevel: 2, decision: 'APPROVED', approverId: 'founder',
      approverRole: 'founder', rationale: undefined, requestedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      previousState: 'PENDING', resultingState: 'APPROVED',
    }),
  );

  let caught: unknown;
  try {
    await harness.owner.pool.query(`update approval_records set decision = 'REJECTED' where organization_id = 'org-N2' and approval_record_id = 'audit-N2'`);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'even the owner/superuser role must be blocked by the immutability trigger');
  assert.equal(pgErrorCode(caught), 'P0001', 'must be the prevent_approval_record_mutation trigger firing, not a permission check');
});

// O — ApprovalRecord DELETE rejected
test('O: ApprovalRecord DELETE is rejected for the application role (permission denied)', async () => {
  const rec = await seedApprovableRecommendation('org-O');
  await approvals.saveRequest({
    approvalRequestId: 'req-O', organizationId: 'org-O', goalId: 'goal-1', recommendationId: rec.recommendationId,
    requestedBy: 'CMO', requiredApprovalLevel: 2, risk: 'low', reason: 'test', status: 'PENDING', createdAt: new Date().toISOString(),
  });
  await approvals.appendRecord(
    Object.freeze({
      approvalRecordId: 'audit-O', approvalRequestId: 'req-O', organizationId: 'org-O', goalId: 'goal-1',
      recommendationId: rec.recommendationId, requiredApprovalLevel: 2, decision: 'APPROVED', approverId: 'founder',
      approverRole: 'founder', rationale: undefined, requestedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      previousState: 'PENDING', resultingState: 'APPROVED',
    }),
  );

  let caught: unknown;
  try {
    await harness.app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org-O', true)`);
      await tx.execute(sql`delete from approval_records where organization_id = 'org-O' and approval_record_id = 'audit-O'`);
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(pgErrorCode(caught), '42501');

  const stillThere = await approvals.listRecords('org-O', 'req-O');
  assert.equal(stillThere.length, 1);
});

test('O (owner role): the immutability trigger blocks DELETE even for the privileged owner role', async () => {
  const rec = await seedApprovableRecommendation('org-O2');
  await approvals.saveRequest({
    approvalRequestId: 'req-O2', organizationId: 'org-O2', goalId: 'goal-1', recommendationId: rec.recommendationId,
    requestedBy: 'CMO', requiredApprovalLevel: 2, risk: 'low', reason: 'test', status: 'PENDING', createdAt: new Date().toISOString(),
  });
  await approvals.appendRecord(
    Object.freeze({
      approvalRecordId: 'audit-O2', approvalRequestId: 'req-O2', organizationId: 'org-O2', goalId: 'goal-1',
      recommendationId: rec.recommendationId, requiredApprovalLevel: 2, decision: 'APPROVED', approverId: 'founder',
      approverRole: 'founder', rationale: undefined, requestedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      previousState: 'PENDING', resultingState: 'APPROVED',
    }),
  );

  let caught: unknown;
  try {
    await harness.owner.pool.query(`delete from approval_records where organization_id = 'org-O2' and approval_record_id = 'audit-O2'`);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'even the owner/superuser role must be blocked by the immutability trigger');
  assert.equal(pgErrorCode(caught), 'P0001');
});

// P — duplicate identifiers fail deterministically
test('P: duplicate identifiers are rejected, not silently overwritten', async () => {
  await organizations.create({ organizationId: 'org-P', organizationType: 'clinic', name: 'Original Name' });
  await assert.rejects(
    organizations.create({ organizationId: 'org-P', organizationType: 'clinic', name: 'Renamed' }),
    DuplicateEntityError,
  );
  assert.equal((await organizations.get('org-P'))?.name, 'Original Name');

  const rec = await seedApprovableRecommendation('org-P2');
  await approvals.saveRequest({
    approvalRequestId: 'req-P', organizationId: 'org-P2', goalId: 'goal-1', recommendationId: rec.recommendationId,
    requestedBy: 'CMO', requiredApprovalLevel: 2, risk: 'low', reason: 'Original reason', status: 'PENDING', createdAt: new Date().toISOString(),
  });
  await assert.rejects(
    approvals.saveRequest({
      approvalRequestId: 'req-P', organizationId: 'org-P2', goalId: 'goal-1', recommendationId: rec.recommendationId,
      requestedBy: 'CMO', requiredApprovalLevel: 2, risk: 'low', reason: 'Overwritten reason', status: 'PENDING', createdAt: new Date().toISOString(),
    }),
    DuplicateEntityError,
  );
  assert.equal((await approvals.getRequest('org-P2', 'req-P'))?.reason, 'Original reason');
});

// Q — full real vertical slice: Organization -> Goal -> CMO -> Recommendation -> Approval -> STOP
test('Q: full vertical slice over real PostgreSQL — Organization -> Goal -> CMO -> Recommendation -> Approval -> persistence', async () => {
  const { CMOExecutive, createMarketingSkillRegistry } = await import('@samvardiq/marketing-intelligence');
  const { toPersistedRecommendation } = await import('../../src/types.js');

  const organization = await organizations.create({
    organizationId: 'org-Q',
    organizationType: 'orthopaedic_clinic',
    name: 'Dr. Deepthi Orthopaedic Clinic',
  });
  const goal = await goals.create({
    goalId: 'goal-gbp-appointments',
    organizationId: organization.organizationId,
    title: 'Increase appointments originating from Google Business Profile',
    description: 'Grow patient appointments sourced from GBP discovery and profile visibility.',
    ownerExecutive: 'CMO',
  });

  const cmo = new CMOExecutive(createMarketingSkillRegistry());
  const outcome = cmo.evaluateGoal({
    organizationId: organization.organizationId,
    goalId: goal.goalId,
    requestedBy: 'founder-ravi',
    goalDescription: goal.title,
    context: {
      organizationProfile: { id: organization.organizationId, name: organization.name },
      gbp: { period: '2026-08', discoverySearches: { current: 320, previous: 480 }, profileCompleteness: 72 },
    },
  });
  assert.equal(outcome.status, 'ok');
  const recommendation = outcome.recommendations[0]!;

  const persisted = await recommendations.save(toPersistedRecommendation(recommendation));

  const directory = new InMemoryApproverDirectory();
  directory.register({ id: 'founder-ravi', organizationId: organization.organizationId, role: 'founder', kind: 'human' });
  const governance = new ApprovalGovernance(approvals, directory);

  const request = await governance.submitApprovalRequest({
    organizationId: organization.organizationId,
    goalId: goal.goalId,
    recommendationId: persisted.recommendationId,
    requestedBy: 'CMO',
    recommendation,
  });
  const record = await governance.decide(request.approvalRequestId, {
    decision: 'APPROVED',
    approverId: 'founder-ravi',
    organizationId: organization.organizationId,
  });

  assert.equal(record.decision, 'APPROVED');

  const chainOrg = await organizations.get(organization.organizationId);
  const chainGoal = await goals.get(organization.organizationId, goal.goalId);
  const chainRec = await recommendations.get(organization.organizationId, persisted.recommendationId);
  const chainRequest = await approvals.getRequest(organization.organizationId, request.approvalRequestId);
  const [chainRecord] = await approvals.listRecords(organization.organizationId, request.approvalRequestId);

  assert.ok(chainOrg && chainGoal && chainRec && chainRequest && chainRecord);
  assert.equal(chainGoal.organizationId, chainOrg.organizationId);
  assert.equal(chainRec.goalId, chainGoal.goalId);
  assert.equal(chainRequest.recommendationId, chainRec.recommendationId);
  assert.equal(chainRecord.approvalRequestId, chainRequest.approvalRequestId);
  assert.equal(chainRecord.decision, 'APPROVED');
  // STOP — no executor, connector, or external call exists anywhere in this chain.
});
