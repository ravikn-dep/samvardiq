import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CMOExecutive, createMarketingSkillRegistry } from '@samvardiq/marketing-intelligence';

import { InMemoryApproverDirectory } from '../src/approverDirectory.js';
import { ApprovalGovernance } from '../src/governance.js';
import { InMemoryApprovalRepository } from '../src/repository.js';

/**
 * Extends the CMO-W1 Session 1 vertical slice (PRD B11):
 *
 *   Goal -> CMO Executive -> Marketing Router -> Domain Expert -> Recommendation
 *        -> Approval Request -> Authorized Human Decision -> Approval Record -> STOP
 *
 * This is the only place approval-governance imports the marketing-intelligence
 * package at all (a devDependency, wired via package.json "file:../marketing-intelligence"),
 * and it does so only to prove the real Recommendation shape flows through
 * unmodified — src/ never imports it, since Layer 6 is domain-agnostic.
 */
test('vertical slice: Goal -> CMO -> Router -> Expert -> Recommendation -> Approval Request -> Decision -> Record -> STOP', () => {
  const cmo = new CMOExecutive(createMarketingSkillRegistry());
  const outcome = cmo.evaluateGoal({
    organizationId: 'org-dr-deepthi',
    goalId: 'goal-gbp-appointments',
    requestedBy: 'founder-ravi',
    goalDescription: 'Increase appointments originating from Google Business Profile.',
    context: {
      organizationProfile: { id: 'org-dr-deepthi', name: 'Dr. Deepthi Orthopaedic Clinic' },
      gbp: {
        period: '2026-08',
        discoverySearches: { current: 320, previous: 480 },
        profileCompleteness: 72,
      },
    },
  });

  assert.equal(outcome.status, 'ok');
  assert.ok(outcome.recommendations.length >= 1);
  const recommendation = outcome.recommendations[0]!;
  assert.equal(recommendation.status, 'Ready for Approval');
  assert.equal(recommendation.requiresApproval, true);

  const directory = new InMemoryApproverDirectory();
  directory.register({ id: 'founder-ravi', organizationId: 'org-dr-deepthi', role: 'founder', kind: 'human' });
  const governance = new ApprovalGovernance(new InMemoryApprovalRepository(), directory);

  const request = governance.submitApprovalRequest({
    organizationId: recommendation.organizationId,
    goalId: recommendation.goalId,
    recommendationId: recommendation.recommendationId,
    requestedBy: 'CMO',
    recommendation, // real Recommendation from Session 1, consumed structurally
  });
  assert.equal(request.status, 'PENDING');
  assert.equal(request.requiredApprovalLevel, recommendation.approvalRequirement);

  const record = governance.decide(request.approvalRequestId, {
    decision: 'APPROVED',
    approverId: 'founder-ravi',
    organizationId: 'org-dr-deepthi',
  });

  assert.equal(record.decision, 'APPROVED');
  assert.equal(record.resultingState, 'APPROVED');
  assert.equal(record.recommendationId, recommendation.recommendationId);

  // STOP: nothing downstream exists. There is no executor, connector, HTTP client,
  // job queue, or GBP/CMS/GA4/WhatsApp/ad-platform call anywhere in this package
  // or in @samvardiq/marketing-intelligence — an approved ApprovalRecord is the
  // final artifact this session produces.
});
