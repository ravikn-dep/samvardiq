import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryApproverDirectory } from '../src/approverDirectory.js';
import {
  AiSelfApprovalError,
  ApprovalRequestExpiredError,
  InsufficientAuthorityError,
  InvalidApprovalStateTransitionError,
  OrganizationMismatchError,
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
test('Scenario F: valid approval transitions PENDING -> APPROVED and creates an ApprovalRecord', () => {
  const { governance } = setup();
  const recommendation = sampleRecommendation({ approvalRequirement: 2 });
  const request = submit(governance, recommendation);
  assert.equal(request.status, 'PENDING');

  const record = governance.decide(request.approvalRequestId, {
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

  assert.equal(governance.getRequest(request.approvalRequestId)?.status, 'APPROVED');
});

// Scenario G — rejection
test('Scenario G: rejection is recorded with rationale and cannot later be approved', () => {
  const { governance } = setup();
  const request = submit(governance, sampleRecommendation());

  const record = governance.decide(request.approvalRequestId, {
    decision: 'REJECTED',
    approverId: 'mgr-anita',
    organizationId: ORG,
    rationale: 'Budget not available this quarter.',
  });

  assert.equal(record.decision, 'REJECTED');
  assert.equal(record.rationale, 'Budget not available this quarter.');
  assert.equal(governance.getRequest(request.approvalRequestId)?.status, 'REJECTED');

  assert.throws(
    () => governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'founder-ravi', organizationId: ORG }),
    InvalidApprovalStateTransitionError,
  );
});

// Scenario H — AI self-approval
test('Scenario H: an AI identity cannot approve a human-required recommendation', () => {
  const { governance } = setup();
  const request = submit(governance, sampleRecommendation());

  assert.throws(
    () => governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'cmo-ai', organizationId: ORG }),
    AiSelfApprovalError,
  );
  assert.equal(governance.getRequest(request.approvalRequestId)?.status, 'PENDING');
});

// Scenario I — insufficient authority
test('Scenario I: an approver with lower authority than required fails closed', () => {
  const { governance } = setup();
  const request = submit(governance, sampleRecommendation({ approvalRequirement: 4 }));

  assert.throws(
    () => governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'hr-priya', organizationId: ORG }),
    InsufficientAuthorityError,
  );
  assert.equal(governance.getRequest(request.approvalRequestId)?.status, 'PENDING');
});

// Scenario J — cross-organization approval
test('Scenario J: an organization cannot approve another organization\'s recommendation', () => {
  const { governance } = setup();
  const request = submit(governance, sampleRecommendation());

  assert.throws(
    () =>
      governance.decide(request.approvalRequestId, {
        decision: 'APPROVED',
        approverId: 'founder-other',
        organizationId: OTHER_ORG,
      }),
    OrganizationMismatchError,
  );
  assert.equal(governance.getRequest(request.approvalRequestId)?.status, 'PENDING');
});

// Scenario K — double decision
test('Scenario K: a completed approval request cannot receive a second decision', () => {
  const { governance } = setup();
  const request = submit(governance, sampleRecommendation());

  const first = governance.decide(request.approvalRequestId, {
    decision: 'APPROVED',
    approverId: 'founder-ravi',
    organizationId: ORG,
  });

  assert.throws(
    () => governance.decide(request.approvalRequestId, { decision: 'REJECTED', approverId: 'founder-ravi', organizationId: ORG, rationale: 'changed mind' }),
    InvalidApprovalStateTransitionError,
  );

  const recordsAfter = governance.listRecords(request.approvalRequestId);
  assert.equal(recordsAfter.length, 1, 'the second, rejected attempt must not create a record');
  assert.deepEqual(recordsAfter[0], first, 'the original record must remain unchanged');
});

// Scenario L — expired request
test('Scenario L: an expired request fails closed on approval and state remains EXPIRED', () => {
  const { governance } = setup();
  const request = submit(governance, sampleRecommendation(), { expiresAt: new Date(Date.now() - 60_000).toISOString() });

  assert.throws(
    () => governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'founder-ravi', organizationId: ORG }),
    ApprovalRequestExpiredError,
  );
  assert.equal(governance.getRequest(request.approvalRequestId)?.status, 'EXPIRED');

  // A second attempt against the now-EXPIRED request must also fail closed, not re-expire it.
  assert.throws(
    () => governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'founder-ravi', organizationId: ORG }),
    InvalidApprovalStateTransitionError,
  );
});

// Scenario M — recommendation integrity mismatch
test('Scenario M: a request referencing an inconsistent recommendation/goal/organization fails closed', () => {
  const { governance } = setup();
  const recommendation = sampleRecommendation({ organizationId: ORG, goalId: 'goal-1' });

  assert.throws(
    () =>
      governance.submitApprovalRequest({
        organizationId: ORG,
        goalId: 'goal-DIFFERENT',
        recommendationId: recommendation.recommendationId,
        requestedBy: 'CMO',
        recommendation,
      }),
    RecommendationIntegrityError,
  );

  assert.throws(
    () =>
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
test('unknown approver identity fails closed', () => {
  const { governance } = setup();
  const request = submit(governance, sampleRecommendation());

  assert.throws(
    () => governance.decide(request.approvalRequestId, { decision: 'APPROVED', approverId: 'ghost-user', organizationId: ORG }),
    UnknownApproverError,
  );
  assert.equal(governance.getRequest(request.approvalRequestId)?.status, 'PENDING');
});
