import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canAdministerMembership } from '../src/membershipAdministrationPolicy.js';
import type { TrustedOrganizationContext } from '../src/types.js';

/** D of the IDENTITY-W7 adversarial matrix (unit level) — organization role does not imply ApproverRole, and the policy reads only role/principalType. */

function context(overrides: Partial<TrustedOrganizationContext> = {}): TrustedOrganizationContext {
  return {
    identityId: 'id-1',
    organizationId: 'org-A',
    membershipId: 'org-A::id-1',
    role: 'OWNER',
    principalType: 'human',
    establishedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('A: an ACTIVE human OWNER may administer', () => {
  assert.equal(canAdministerMembership(context({ role: 'OWNER', principalType: 'human' })), true);
});

test('B: a MEMBER may not administer', () => {
  assert.equal(canAdministerMembership(context({ role: 'MEMBER' })), false);
});

test('C: a VIEWER may not administer', () => {
  assert.equal(canAdministerMembership(context({ role: 'VIEWER' })), false);
});

test('AU: a service-principal OWNER may not administer (human-only route)', () => {
  assert.equal(canAdministerMembership(context({ role: 'OWNER', principalType: 'service' })), false);
});

test('D: the policy never reads approverRole — an OWNER with no approverRole at all still administers, and the function signature has no approverRole parameter', () => {
  const ownerNoApproval = context({ role: 'OWNER', approverRole: undefined });
  assert.equal(canAdministerMembership(ownerNoApproval), true);
  // approverRole presence/absence must never change the outcome — organization access and approval authority are unrelated.
  const ownerWithApproval = context({ role: 'OWNER', approverRole: 'founder' });
  assert.equal(canAdministerMembership(ownerWithApproval), true);
});
