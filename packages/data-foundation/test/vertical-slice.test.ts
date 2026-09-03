import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApprovalGovernance, InMemoryApproverDirectory } from '@samvardiq/approval-governance';
import { CMOExecutive, createMarketingSkillRegistry } from '@samvardiq/marketing-intelligence';

import {
  InMemoryGoalRepository,
  InMemoryOrganizationRepository,
  InMemoryRecommendationRepository,
  PersistentApprovalRepository,
  toPersistedRecommendation,
} from '../src/index.js';

/**
 * Full DATA-W1 Session 3 reference slice (PRD section 12):
 *
 *   Organization -> Goal -> CMO evaluates Goal -> Recommendation
 *     -> persist Recommendation -> Approval Request -> persist request
 *     -> human approves -> Approval Record -> retrieve full chain -> STOP
 *
 * Every repository here is the real Data Foundation implementation; the CMO
 * and Governance layers are the real Session 1/2 packages (file: devDependencies),
 * not simulated objects.
 */
test('J: full vertical slice — Organization -> Goal -> CMO -> Recommendation -> Approval -> persistence', () => {
  const organizations = new InMemoryOrganizationRepository();
  const goals = new InMemoryGoalRepository(organizations);
  const recommendations = new InMemoryRecommendationRepository(goals);
  const approvals = new PersistentApprovalRepository(organizations, recommendations);
  const directory = new InMemoryApproverDirectory();
  directory.register({ id: 'founder-ravi', organizationId: 'org-dr-deepthi', role: 'founder', kind: 'human' });
  const governance = new ApprovalGovernance(approvals, directory);

  const organization = organizations.create({
    organizationId: 'org-dr-deepthi',
    organizationType: 'orthopaedic_clinic',
    name: 'Dr. Deepthi Orthopaedic Clinic',
  });

  const goal = goals.create({
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
      gbp: {
        period: '2026-08',
        discoverySearches: { current: 320, previous: 480 },
        profileCompleteness: 72,
      },
    },
  });
  assert.equal(outcome.status, 'ok');
  const recommendation = outcome.recommendations[0]!;

  const persistedRecommendation = recommendations.save(toPersistedRecommendation(recommendation));
  assert.equal(persistedRecommendation.organizationId, organization.organizationId);
  assert.equal(persistedRecommendation.goalId, goal.goalId);

  const request = governance.submitApprovalRequest({
    organizationId: organization.organizationId,
    goalId: goal.goalId,
    recommendationId: persistedRecommendation.recommendationId,
    requestedBy: 'CMO',
    recommendation,
  });
  assert.equal(request.status, 'PENDING');
  assert.equal(approvals.getRequest(request.approvalRequestId)?.approvalRequestId, request.approvalRequestId);

  const record = governance.decide(request.approvalRequestId, {
    decision: 'APPROVED',
    approverId: 'founder-ravi',
    organizationId: organization.organizationId,
  });
  assert.equal(record.decision, 'APPROVED');

  // Retrieve the complete organization-scoped governance chain.
  const chainOrg = organizations.get(organization.organizationId);
  const chainGoal = goals.get(organization.organizationId, goal.goalId);
  const chainRecommendation = recommendations.get(organization.organizationId, persistedRecommendation.recommendationId);
  const chainRequest = approvals.getRequest(request.approvalRequestId);
  const [chainRecord] = approvals.listRecords(request.approvalRequestId);

  assert.ok(chainOrg && chainGoal && chainRecommendation && chainRequest && chainRecord);
  assert.equal(chainGoal.organizationId, chainOrg.organizationId);
  assert.equal(chainRecommendation.organizationId, chainOrg.organizationId);
  assert.equal(chainRecommendation.goalId, chainGoal.goalId);
  assert.equal(chainRequest.organizationId, chainOrg.organizationId);
  assert.equal(chainRequest.recommendationId, chainRecommendation.recommendationId);
  assert.equal(chainRecord.approvalRequestId, chainRequest.approvalRequestId);
  assert.equal(chainRecord.decision, 'APPROVED');
});

// K — no execution occurs after an approved record exists: the package exports no execution surface at all.
test('K: data-foundation exposes no execution/dispatch capability', async () => {
  const dataFoundation = await import('../src/index.js');
  const forbidden = /execute|dispatch|publish|sendmessage|httprequest|invokeconnector|automation/i;
  const offending = Object.keys(dataFoundation).filter((name) => forbidden.test(name));
  assert.deepEqual(offending, []);
});
