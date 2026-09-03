import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CMOExecutive,
  ClinicalDataBoundaryViolation,
  SkillNotApprovedError,
  SkillNotRegisteredError,
  checkRecommendationPolicy,
  createMarketingSkillRegistry,
} from '../src/index.js';
import type { SkillDefinition, SkillInvocation } from '../src/types.js';

function baseInput(overrides: Partial<Parameters<CMOExecutive['evaluateGoal']>[0]> = {}) {
  return {
    organizationId: 'org-dr-deepthi',
    goalId: 'goal-1',
    requestedBy: 'founder-ravi',
    goalDescription: 'placeholder',
    context: {},
    ...overrides,
  };
}

// Registry — reused across scenarios
function freshCMO() {
  const registry = createMarketingSkillRegistry();
  return { registry, cmo: new CMOExecutive(registry) };
}

test('registry lists the 4 session-1 skills by executive and domain', () => {
  const { registry } = freshCMO();
  const byExecutive = registry.listByExecutive('CMO').map((s) => s.id).sort();
  const byDomain = registry.listByDomain('marketing').map((s) => s.id).sort();
  const expected = ['campaign-analytics', 'cmo-advisor', 'healthcare-local-growth', 'marketing-ops'].sort();
  assert.deepEqual(byExecutive, expected);
  assert.deepEqual(byDomain, expected);
});

// Scenario A — GBP goal -> CMO -> router -> healthcare-local-growth -> recommendation requiring approval
test('Scenario A: increase appointments from GBP routes to healthcare-local-growth with an approvable recommendation', () => {
  const { cmo } = freshCMO();
  const outcome = cmo.evaluateGoal(
    baseInput({
      goalDescription: 'Increase appointments originating from Google Business Profile.',
      context: {
        organizationProfile: { id: 'org-dr-deepthi', name: 'Dr. Deepthi Orthopaedic Clinic', city: 'Vizag' },
        gbp: {
          period: '2026-08',
          discoverySearches: { current: 320, previous: 480 },
          profileCompleteness: 72,
          reviewCount: 41,
          averageRating: 4.6,
          reviewResponseRateDays: 10,
        },
      },
    }),
  );

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.invokedSkills, ['healthcare-local-growth']);
  assert.ok(outcome.recommendations.length >= 1, 'expected at least one recommendation');
  for (const rec of outcome.recommendations) {
    assert.ok(rec.evidence.length > 0, 'recommendation must cite evidence');
    assert.ok(rec.confidence > 0 && rec.confidence <= 100);
    assert.equal(rec.requiresApproval, true, 'GBP-facing recommendations must require approval');
    assert.equal(rec.status, 'Ready for Approval');
  }
});

// Scenario B — conversion goal with no funnel evidence -> campaign-analytics, no fabricated data
test('Scenario B: conversion question without funnel data identifies missing evidence, invents nothing', () => {
  const { cmo } = freshCMO();
  const outcome = cmo.evaluateGoal(
    baseInput({
      goalDescription: 'Determine why clinic enquiries are not becoming consultations.',
      context: {
        organizationProfile: { id: 'org-dr-deepthi', name: 'Dr. Deepthi Orthopaedic Clinic' },
      },
    }),
  );

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(outcome.invokedSkills, ['campaign-analytics']);
  assert.equal(outcome.recommendations.length, 0, 'must not fabricate a recommendation without funnel data');
  const result = outcome.results[0]!;
  assert.ok(result.findings.some((f) => /insufficient/i.test(f)));
  assert.ok(result.confidence <= 30, 'confidence must stay low without evidence');
});

// Scenario C — unregistered / unapproved skill invocation fails closed
test('Scenario C: unregistered skill invocation fails closed', () => {
  const { registry } = freshCMO();
  const invocation: SkillInvocation = {
    invocationId: 'inv-1',
    organizationId: 'org-dr-deepthi',
    goalId: 'goal-1',
    skillId: 'seo-magic-autopilot',
    requestedBy: 'founder-ravi',
    context: {},
    timestamp: new Date().toISOString(),
  };
  assert.throws(() => registry.invoke('seo-magic-autopilot', invocation), SkillNotRegisteredError);
});

test('Scenario C (variant): disabled/unapproved skill status fails closed even when registered', () => {
  const { registry } = freshCMO();
  const candidateDefinition: SkillDefinition = {
    id: 'experimental-ads-autopilot',
    name: 'Experimental Ads Autopilot',
    version: '0.0.1',
    domain: 'marketing',
    owningExecutive: 'CMO',
    description: 'Not yet approved for runtime use.',
    capabilities: [],
    allowedInputs: [],
    allowedOutputs: [],
    requiredEvidence: [],
    riskLevel: 'high',
    approvalPolicy: 4,
    source: 'internal',
    sourceVersion: '0.0.1',
    license: 'MIT',
    status: 'CANDIDATE',
  };
  registry.register(candidateDefinition, (invocation) => ({
    invocationId: invocation.invocationId,
    skillId: candidateDefinition.id,
    organizationId: invocation.organizationId,
    goalId: invocation.goalId,
    findings: [],
    evidence: [],
    confidence: 0,
    assumptions: [],
    risks: [],
    recommendations: [],
    requiresApproval: false,
    generatedAt: new Date().toISOString(),
  }));

  assert.throws(
    () =>
      registry.invoke('experimental-ads-autopilot', {
        invocationId: 'inv-2',
        organizationId: 'org-dr-deepthi',
        goalId: 'goal-1',
        skillId: 'experimental-ads-autopilot',
        requestedBy: 'founder-ravi',
        context: {},
        timestamp: new Date().toISOString(),
      }),
    SkillNotApprovedError,
  );
});

// Scenario D — clinical/patient data in marketing context is rejected before reaching an expert
test('Scenario D: clinical patient information in marketing context is rejected', () => {
  const { cmo } = freshCMO();
  assert.throws(
    () =>
      cmo.evaluateGoal(
        baseInput({
          goalDescription: 'Improve Google Business Profile performance.',
          context: {
            organizationProfile: { id: 'org-dr-deepthi', name: 'Dr. Deepthi Orthopaedic Clinic' },
            gbp: { period: '2026-08', profileCompleteness: 80 },
            recentEnquiry: {
              patientName: 'Jane Doe',
              phone: '+91-9000000000',
              diagnosis: 'ACL tear',
            },
          },
        }),
      ),
    ClinicalDataBoundaryViolation,
  );
});

// Scenario E — a recommendation proposing fake reviews is rejected as policy-invalid.
// CMOExecutive.evaluateGoal runs every skill-produced recommendation through this
// exact function (see cmoExecutive.ts) before it can reach 'Ready for Approval'.
test('Scenario E: a recommendation proposing fake reviews is rejected as policy-invalid', () => {
  const check = checkRecommendationPolicy({
    title: 'Boost review rating fast',
    recommendedAction: 'Post fake reviews from staff accounts to raise the average rating this week.',
    rationale: 'Fake reviews are the fastest way to improve the public rating before the campaign launch.',
  });
  assert.equal(check.valid, false);
  assert.ok(check.violations.length > 0);
});
