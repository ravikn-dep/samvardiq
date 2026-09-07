import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryApproverDirectory } from '../src/approverDirectory.js';
import {
  AiSelfApprovalError,
  ApprovalRequestExpiredError,
  ApprovalRequestNotFoundError,
  InsufficientAuthorityError,
  InvalidApprovalStateTransitionError,
  RecommendationIntegrityError,
  UnknownApproverError,
} from '../src/errors.js';
import { ApprovalGovernance } from '../src/governance.js';
import { InMemoryApprovalRepository } from '../src/repository.js';
import type { RecommendationRef } from '../src/types.js';

const ORG = 'org-dr-deepthi';
const OTHER_ORG = 'org-other-clinic';

function setup() {
  const repository = new InMemoryApprovalRepository();
  const directory = new InMemoryApproverDirectory();
  directory.register({ id: 'mgr-anita', organizationId: ORG, role: 'marketing_manager', kind: 'human' });
  directory.register({ id: 'founder-ravi', organizationId: ORG, role: 'founder', kind: 'human' });
  directory.register({ id: 'hr-priya', organizationId: ORG, role: 'hr_manager', kind: 'human' });
  directory.register({ id: 'cmo-ai', organizationId: ORG, role: 'founder', kind: 'ai' });
  directory.register({ id: 'founder-other', organizationId: OTHER_ORG, role: 'founder', kind: 'human' });
  const governance = new ApprovalGovernance(repository, directory);
  return { repository, directory, governance };
}

function sampleRecommendation(overrides: Partial<RecommendationRef> = {}): RecommendationRef {
  return {
    recommendationId: 'rec-1',
    organizationId: ORG,
    goalId: 'goal-1',
    approvalRequirement: 2,
    risk: 'low',
    title: 'Complete Google Business Profile information',
    ...overrides,
  };
}

function submit(governance: ApprovalGovernance, recommendation: RecommendationRef, extra: { expiresAt?: string } = {}) {
  return governance.submitApprovalRequest({
    organizationId: recommendation.organizationId,
    goalId: recommendation.goalId,
    recommendationId: recommendation.recommendationId,
    requestedBy: 'CMO',
    recommendation,
    ...extra,
  });
}

// Scenario F — valid approval
test('Scenario F: valid approval transitions PENDING -> APPROVED and creates an ApprovalRecord', async () => {
  const { governance } = setup();
  const recommendation = sampleRecommendation({ approvalRequirement: 2 });
  const request = await submit(governance, recommendation);
  assert.equal(request.status, 'PENDING');

  const record = await governance.decide(request.approvalRequestId, {
    decision: 'APPROVED',
    approverId: 'mgr-anita',
    organizationId: ORG,
  });

  assert.equal(record.previousState, 'PENDING');
  assert.equal(record.resultingState, 'APPROVED');
  assert.equal(record.decision, 'APPROVED');
  assert.equal(record.approverId, 'mgr-anita');
  assert.equal(record.approverRole, 'marketing_manager');
  assert.equal(record.recommendationId, recommendation.recommendationId);
  assert.equal(record.organizationId, ORG);
  assert.equal(record.goalId, recommendation.goalId);

  assert.equal((await governance.getRequest(ORG, request.approvalRequestId))?.status, 'APPROVED');
});

// Scenario G — rejection
test('Scenario G: rejection is recorded with rationale and cannot later be approved', async () => {
  const { governance } = setup();
  const request = await submit(governance, sampleRecommendation());

  const record = await governance.decide(request.approvalRequestId, {
    decision: 'REJECTED',
    approverId: 'mgr-anita',
    organizationId: ORG,
    rationale: 'Budget not available this quarter.',
  });

  assert.equal(record.decision, 'REJECTED');
  assert.equal(record.rationale, 'Budget not available this quarter.');
  assert.equal((await governance.getRequest(ORG, request.approvalRequestId))?.status, 'REJECTED');

  await assert.rejects(
    governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'founder-ravi', organizationId: ORG }),
    InvalidApprovalStateTransitionError,
  );
});

// Scenario H — AI self-approval
test('Scenario H: an AI identity cannot approve a human-required recommendation', async () => {
  const { governance } = setup();
  const request = await submit(governance, sampleRecommendation());

  await assert.rejects(
    governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'cmo-ai', organizationId: ORG }),
    AiSelfApprovalError,
  );
  assert.equal((await governance.getRequest(ORG, request.approvalRequestId))?.status, 'PENDING');
});

// Scenario I — insufficient authority
test('Scenario I: an approver with lower authority than required fails closed', async () => {
  const { governance } = setup();
  const request = await submit(governance, sampleRecommendation({ approvalRequirement: 4 }));

  await assert.rejects(
    governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'hr-priya', organizationId: ORG }),
    InsufficientAuthorityError,
  );
  assert.equal((await governance.getRequest(ORG, request.approvalRequestId))?.status, 'PENDING');
});

// Scenario J — cross-organization approval
// DATA-W3: the lookup is now organization-scoped (mirrors Postgres RLS row-hiding —
// see governance.ts decide() doc comment), so a cross-organization attempt surfaces
// as ApprovalRequestNotFoundError, not a distinct OrganizationMismatchError — the
// data layer must not reveal that the id exists under a different organization.
test('Scenario J: an organization cannot approve another organization\'s recommendation', async () => {
  const { governance } = setup();
  const request = await submit(governance, sampleRecommendation());

  await assert.rejects(
    governance.decide(request.approvalRequestId, {
      decision: 'APPROVED',
      approverId: 'founder-other',
      organizationId: OTHER_ORG,
    }),
    ApprovalRequestNotFoundError,
  );
  assert.equal((await governance.getRequest(ORG, request.approvalRequestId))?.status, 'PENDING');
});

// Scenario K — double decision
test('Scenario K: a completed approval request cannot receive a second decision', async () => {
  const { governance } = setup();
  const request = await submit(governance, sampleRecommendation());

  const first = await governance.decide(request.approvalRequestId, {
    decision: 'APPROVED',
    approverId: 'founder-ravi',
    organizationId: ORG,
  });

  await assert.rejects(
    governance.decide(request.approvalRequestId, { decision: 'REJECTED', approverId: 'founder-ravi', organizationId: ORG, rationale: 'changed mind' }),
    InvalidApprovalStateTransitionError,
  );

  const recordsAfter = await governance.listRecords(ORG, request.approvalRequestId);
  assert.equal(recordsAfter.length, 1, 'the second, rejected attempt must not create a record');
  assert.deepEqual(recordsAfter[0], first, 'the original record must remain unchanged');
});

// Scenario L — expired request
test('Scenario L: an expired request fails closed on approval and state remains EXPIRED', async () => {
  const { governance } = setup();
  const request = await submit(governance, sampleRecommendation(), { expiresAt: new Date(Date.now() - 60_000).toISOString() });

  await assert.rejects(
    governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'founder-ravi', organizationId: ORG }),
    ApprovalRequestExpiredError,
  );
  assert.equal((await governance.getRequest(ORG, request.approvalRequestId))?.status, 'EXPIRED');

  // A second attempt against the now-EXPIRED request must also fail closed, not re-expire it.
  await assert.rejects(
    governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'founder-ravi', organizationId: ORG }),
    InvalidApprovalStateTransitionError,
  );
});

// Scenario M — recommendation integrity mismatch
test('Scenario M: a request referencing an inconsistent recommendation/goal/organization fails closed', async () => {
  const { governance } = setup();
  const recommendation = sampleRecommendation({ organizationId: ORG, goalId: 'goal-1' });

  await assert.rejects(
    governance.submitApprovalRequest({
      organizationId: ORG,
      goalId: 'goal-DIFFERENT',
      recommendationId: recommendation.recommendationId,
      requestedBy: 'CMO',
      recommendation,
    }),
    RecommendationIntegrityError,
  );

  await assert.rejects(
    governance.submitApprovalRequest({
      organizationId: OTHER_ORG,
      goalId: recommendation.goalId,
      recommendationId: recommendation.recommendationId,
      requestedBy: 'CMO',
      recommendation,
    }),
    RecommendationIntegrityError,
  );
});

// Additional invariant from B3/B7 — unknown approver identity
test('unknown approver identity fails closed', async () => {
  const { governance } = setup();
  const request = await submit(governance, sampleRecommendation());

  await assert.rejects(
    governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'ghost-user', organizationId: ORG }),
    UnknownApproverError,
  );
  assert.equal((await governance.getRequest(ORG, request.approvalRequestId))?.status, 'PENDING');
});
