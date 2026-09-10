import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAllowedRoleChange, isAllowedStatusTransition } from '../src/membershipLifecycle.js';

/** T, U, R, S of the IDENTITY-W7 adversarial matrix (unit level) — the controlled transition graph. */

test('T: every canonical status transition named in section 11 is allowed', () => {
  assert.equal(isAllowedStatusTransition('INVITED', 'ACTIVE'), true);
  assert.equal(isAllowedStatusTransition('INVITED', 'REVOKED'), true);
  assert.equal(isAllowedStatusTransition('ACTIVE', 'SUSPENDED'), true);
  assert.equal(isAllowedStatusTransition('ACTIVE', 'REVOKED'), true);
  assert.equal(isAllowedStatusTransition('SUSPENDED', 'ACTIVE'), true);
  assert.equal(isAllowedStatusTransition('SUSPENDED', 'REVOKED'), true);
});

test('U: REVOKED is terminal — no resurrection to any state, including back to REVOKED', () => {
  assert.equal(isAllowedStatusTransition('REVOKED', 'ACTIVE'), false);
  assert.equal(isAllowedStatusTransition('REVOKED', 'SUSPENDED'), false);
  assert.equal(isAllowedStatusTransition('REVOKED', 'INVITED'), false);
  assert.equal(isAllowedStatusTransition('REVOKED', 'REVOKED'), false);
});

test('T (variant): unreachable/invalid edges are rejected', () => {
  assert.equal(isAllowedStatusTransition('INVITED', 'SUSPENDED'), false, 'an invitation cannot be suspended — it was never active');
  assert.equal(isAllowedStatusTransition('ACTIVE', 'INVITED'), false, 'an active membership cannot revert to invited');
  assert.equal(isAllowedStatusTransition('SUSPENDED', 'INVITED'), false);
});

test('a status transition to the identical status is not a defined edge', () => {
  assert.equal(isAllowedStatusTransition('ACTIVE', 'ACTIVE'), false);
  assert.equal(isAllowedStatusTransition('INVITED', 'INVITED'), false);
  assert.equal(isAllowedStatusTransition('SUSPENDED', 'SUSPENDED'), false);
});

test('R: a role change is allowed only while the membership is ACTIVE', () => {
  assert.equal(isAllowedRoleChange('ACTIVE', 'MEMBER', 'OWNER'), true);
  assert.equal(isAllowedRoleChange('INVITED', 'MEMBER', 'OWNER'), false);
  assert.equal(isAllowedRoleChange('SUSPENDED', 'MEMBER', 'OWNER'), false);
  assert.equal(isAllowedRoleChange('REVOKED', 'MEMBER', 'OWNER'), false);
});

test('S: changing a role to the identical role is rejected as a no-op, not silently accepted', () => {
  assert.equal(isAllowedRoleChange('ACTIVE', 'OWNER', 'OWNER'), false);
  assert.equal(isAllowedRoleChange('ACTIVE', 'MEMBER', 'MEMBER'), false);
});
