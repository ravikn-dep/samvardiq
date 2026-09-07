import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DuplicateEntityError,
  GoalNotFoundError,
  InMemoryGoalRepository,
  InMemoryOrganizationRepository,
  InMemoryRecommendationRepository,
  OrganizationBoundaryViolation,
  OrganizationNotFoundError,
  PersistentApprovalRepository,
  ReferentialIntegrityViolation,
  type PersistedRecommendation,
} from '../src/index.js';

function setup() {
  const organizations = new InMemoryOrganizationRepository();
  const goals = new InMemoryGoalRepository(organizations);
  const recommendations = new InMemoryRecommendationRepository(goals);
  const approvals = new PersistentApprovalRepository(organizations, recommendations);
  return { organizations, goals, recommendations, approvals };
}

function sampleRecommendation(overrides: Partial<PersistedRecommendation> = {}): PersistedRecommendation {
  return {
    recommendationId: 'rec-1',
    organizationId: 'org-dr-deepthi',
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

// A — organization creation/retrieval
test('A: organization can be created and retrieved', async () => {
  const { organizations } = setup();
  const org = await organizations.create({ organizationId: 'org-dr-deepthi', organizationType: 'orthopaedic_clinic', name: 'Dr. Deepthi Orthopaedic Clinic' });
  assert.equal(org.status, 'active');
  assert.deepEqual(await organizations.get('org-dr-deepthi'), org);
  assert.equal(await organizations.get('org-unknown'), undefined);
});

// B — goal must belong to an existing organization
test('B: goal creation fails closed when the organization does not exist', async () => {
  const { goals } = setup();
  await assert.rejects(
    goals.create({ goalId: 'goal-1', organizationId: 'org-missing', title: 'Increase appointments', description: '...' }),
    OrganizationNotFoundError,
  );
});

// C — recommendation must belong to an existing goal, same organization
test('C: recommendation save fails closed when its goal does not exist under that organization', async () => {
  const { organizations, recommendations } = setup();
  await organizations.create({ organizationId: 'org-dr-deepthi', organizationType: 'clinic', name: 'Dr. Deepthi Clinic' });
  await assert.rejects(
    recommendations.save(sampleRecommendation({ goalId: 'goal-never-created' })),
    GoalNotFoundError,
  );
});

// D — cross-organization recommendation persistence fails closed
test('D: recommendation save fails closed when goal exists under a different organization', async () => {
  const { organizations, goals, recommendations } = setup();
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'Clinic B' });
  await goals.create({ goalId: 'goal-1', organizationId: 'org-A', title: 'Increase appointments', description: '...' });

  await assert.rejects(
    recommendations.save(sampleRecommendation({ organizationId: 'org-B', goalId: 'goal-1' })),
    GoalNotFoundError,
    'org-B has no goal-1 — org-A\'s goal-1 must not be reachable through org-B',
  );
});

// E — approval persistence cannot cross the organization boundary
test('E: approval request save fails closed when the recommendation belongs to a different organization', async () => {
  const { organizations, goals, recommendations, approvals } = setup();
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'Clinic B' });
  await goals.create({ goalId: 'goal-1', organizationId: 'org-A', title: 'Increase appointments', description: '...' });
  await recommendations.save(sampleRecommendation({ organizationId: 'org-A', goalId: 'goal-1' }));

  await assert.rejects(
    approvals.saveRequest({
      approvalRequestId: 'req-1',
      organizationId: 'org-B',
      goalId: 'goal-1',
      recommendationId: 'rec-1',
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

// F — orphan recommendation (goal never existed at all) fails closed
test('F: orphan recommendation referencing a goal that was never created fails closed', async () => {
  const { organizations, recommendations } = setup();
  await organizations.create({ organizationId: 'org-dr-deepthi', organizationType: 'clinic', name: 'Dr. Deepthi Clinic' });
  await assert.rejects(recommendations.save(sampleRecommendation()), GoalNotFoundError);
});

// G — orphan approval request/record fail closed
test('G: orphan approval request (unknown recommendation) fails closed', async () => {
  const { organizations, approvals } = setup();
  await organizations.create({ organizationId: 'org-dr-deepthi', organizationType: 'clinic', name: 'Dr. Deepthi Clinic' });
  await assert.rejects(
    approvals.saveRequest({
      approvalRequestId: 'req-orphan',
      organizationId: 'org-dr-deepthi',
      goalId: 'goal-1',
      recommendationId: 'rec-never-persisted',
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

test('G: orphan approval record (unknown approval request) fails closed', async () => {
  const { approvals } = setup();
  await assert.rejects(
    approvals.appendRecord({
      approvalRecordId: 'rec-audit-1',
      approvalRequestId: 'req-never-persisted',
      organizationId: 'org-dr-deepthi',
      goalId: 'goal-1',
      recommendationId: 'rec-1',
      requiredApprovalLevel: 2,
      decision: 'APPROVED',
      approverId: 'founder-ravi',
      approverRole: 'founder',
      rationale: undefined,
      requestedAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(),
      previousState: 'PENDING',
      resultingState: 'APPROVED',
    }),
    ReferentialIntegrityViolation,
  );
});

// H — organization-scoped lookup cannot retrieve another organization's entities
test('H: organization-scoped lookup cannot cross into another organization\'s goals or recommendations', async () => {
  const { organizations, goals, recommendations } = setup();
  await organizations.create({ organizationId: 'org-A', organizationType: 'clinic', name: 'Clinic A' });
  await organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'Clinic B' });
  await goals.create({ goalId: 'goal-shared-id', organizationId: 'org-A', title: 'Org A goal', description: '...' });
  await goals.create({ goalId: 'goal-shared-id', organizationId: 'org-B', title: 'Org B goal', description: '...' });
  await recommendations.save(sampleRecommendation({ organizationId: 'org-A', goalId: 'goal-shared-id', recommendationId: 'rec-shared-id' }));
  await recommendations.save(sampleRecommendation({ organizationId: 'org-B', goalId: 'goal-shared-id', recommendationId: 'rec-shared-id', title: 'Org B recommendation' }));

  assert.equal((await goals.get('org-A', 'goal-shared-id'))?.title, 'Org A goal');
  assert.equal((await goals.get('org-B', 'goal-shared-id'))?.title, 'Org B goal');
  assert.equal((await recommendations.get('org-A', 'rec-shared-id'))?.title, 'Complete Google Business Profile information');
  assert.equal((await recommendations.get('org-B', 'rec-shared-id'))?.title, 'Org B recommendation');

  const orgAGoals = await goals.listByOrganization('org-A');
  assert.deepEqual(orgAGoals.map((g) => g.goalId), ['goal-shared-id']);
  assert.equal(orgAGoals.length, 1, 'org-A listing must not include org-B goals');
});

// I — ApprovalRecord remains append-only / immutable
test('I: ApprovalRecord objects are frozen and the repository exposes no update/delete path', async () => {
  const { organizations, goals, recommendations, approvals } = setup();
  await organizations.create({ organizationId: 'org-dr-deepthi', organizationType: 'clinic', name: 'Dr. Deepthi Clinic' });
  await goals.create({ goalId: 'goal-1', organizationId: 'org-dr-deepthi', title: 'Increase appointments', description: '...' });
  await recommendations.save(sampleRecommendation());
  await approvals.saveRequest({
    approvalRequestId: 'req-1',
    organizationId: 'org-dr-deepthi',
    goalId: 'goal-1',
    recommendationId: 'rec-1',
    requestedBy: 'CMO',
    requiredApprovalLevel: 2,
    risk: 'low',
    reason: 'test',
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  });
  await approvals.appendRecord(
    Object.freeze({
      approvalRecordId: 'audit-1',
      approvalRequestId: 'req-1',
      organizationId: 'org-dr-deepthi',
      goalId: 'goal-1',
      recommendationId: 'rec-1',
      requiredApprovalLevel: 2,
      decision: 'APPROVED',
      approverId: 'founder-ravi',
      approverRole: 'founder',
      rationale: undefined,
      requestedAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(),
      previousState: 'PENDING',
      resultingState: 'APPROVED',
    }),
  );

  const [record] = await approvals.listRecords('org-dr-deepthi', 'req-1');
  assert.ok(record);
  assert.ok(Object.isFrozen(record), 'a persisted ApprovalRecord must be frozen');
  assert.throws(() => {
    'use strict';
    (record as { decision: string }).decision = 'REJECTED';
  });
  assert.equal((await approvals.listRecords('org-dr-deepthi', 'req-1'))[0]?.decision, 'APPROVED', 'the stored record must be unaffected');
  assert.equal(
    typeof (approvals as unknown as { updateRecord?: unknown }).updateRecord,
    'undefined',
    'no updateRecord method may exist on the repository',
  );
});

// L — duplicate identifiers fail deterministically rather than silently overwriting
test('L: duplicate identifiers are rejected, not silently overwritten, across all repositories', async () => {
  const { organizations, goals, recommendations, approvals } = setup();
  await organizations.create({ organizationId: 'org-dr-deepthi', organizationType: 'clinic', name: 'Original Name' });
  await assert.rejects(
    organizations.create({ organizationId: 'org-dr-deepthi', organizationType: 'clinic', name: 'Renamed' }),
    DuplicateEntityError,
  );
  assert.equal((await organizations.get('org-dr-deepthi'))?.name, 'Original Name');

  await goals.create({ goalId: 'goal-1', organizationId: 'org-dr-deepthi', title: 'Original Title', description: '...' });
  await assert.rejects(
    goals.create({ goalId: 'goal-1', organizationId: 'org-dr-deepthi', title: 'Renamed Title', description: '...' }),
    DuplicateEntityError,
  );
  assert.equal((await goals.get('org-dr-deepthi', 'goal-1'))?.title, 'Original Title');

  await recommendations.save(sampleRecommendation({ title: 'Original Recommendation' }));
  await assert.rejects(
    recommendations.save(sampleRecommendation({ title: 'Renamed Recommendation' })),
    DuplicateEntityError,
  );
  assert.equal((await recommendations.get('org-dr-deepthi', 'rec-1'))?.title, 'Original Recommendation');

  await approvals.saveRequest({
    approvalRequestId: 'req-1',
    organizationId: 'org-dr-deepthi',
    goalId: 'goal-1',
    recommendationId: 'rec-1',
    requestedBy: 'CMO',
    requiredApprovalLevel: 2,
    risk: 'low',
    reason: 'Original reason',
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  });
  await assert.rejects(
    approvals.saveRequest({
      approvalRequestId: 'req-1',
      organizationId: 'org-dr-deepthi',
      goalId: 'goal-1',
      recommendationId: 'rec-1',
      requestedBy: 'CMO',
      requiredApprovalLevel: 2,
      risk: 'low',
      reason: 'Overwritten reason',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    }),
    DuplicateEntityError,
  );
  assert.equal((await approvals.getRequest('org-dr-deepthi', 'req-1'))?.reason, 'Original reason');
});

// G (continued) — an approval record whose org/goal/recommendation disagrees with its own request fails closed
test('G: approval record mismatching its own approval request\'s organization/goal/recommendation fails closed', async () => {
  const { organizations, goals, recommendations, approvals } = setup();
  await organizations.create({ organizationId: 'org-dr-deepthi', organizationType: 'clinic', name: 'Dr. Deepthi Clinic' });
  await goals.create({ goalId: 'goal-1', organizationId: 'org-dr-deepthi', title: 'Increase appointments', description: '...' });
  await recommendations.save(sampleRecommendation());
  await approvals.saveRequest({
    approvalRequestId: 'req-1',
    organizationId: 'org-dr-deepthi',
    goalId: 'goal-1',
    recommendationId: 'rec-1',
    requestedBy: 'CMO',
    requiredApprovalLevel: 2,
    risk: 'low',
    reason: 'test',
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  });

  await assert.rejects(
    approvals.appendRecord(
      Object.freeze({
        approvalRecordId: 'audit-mismatch',
        approvalRequestId: 'req-1',
        organizationId: 'org-someone-else', // disagrees with the stored request's organizationId
        goalId: 'goal-1',
        recommendationId: 'rec-1',
        requiredApprovalLevel: 2,
        decision: 'APPROVED',
        approverId: 'founder-ravi',
        approverRole: 'founder',
        rationale: undefined,
        requestedAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
        previousState: 'PENDING',
        resultingState: 'APPROVED',
      }),
    ),
    OrganizationBoundaryViolation,
  );
});
