import type { MembershipStatus, OrganizationRole } from './types.js';

/**
 * IDENTITY-W7 — the controlled status-transition graph (section 11).
 * Never `status = request.body.status`: every transition is one of these
 * named, pre-approved edges or it is rejected. REVOKED is terminal — no
 * resurrection, per section 11's explicit default ("do not permit
 * resurrection from REVOKED unless canonical architecture explicitly
 * allows it" — nothing does).
 */
const ALLOWED_STATUS_TRANSITIONS: Record<MembershipStatus, ReadonlySet<MembershipStatus>> = {
  INVITED: new Set<MembershipStatus>(['ACTIVE', 'REVOKED']),
  ACTIVE: new Set<MembershipStatus>(['SUSPENDED', 'REVOKED']),
  SUSPENDED: new Set<MembershipStatus>(['ACTIVE', 'REVOKED']),
  REVOKED: new Set<MembershipStatus>(),
};

export function isAllowedStatusTransition(from: MembershipStatus, to: MembershipStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].has(to);
}

/**
 * Role change is permitted only while a membership is ACTIVE — an
 * INVITED membership's role is set once at creation (see
 * createInvitedMembership), and a SUSPENDED/REVOKED membership has no
 * organizational activity to re-role. Changing to the identical role is
 * rejected as a no-op, not silently accepted, so every role-change audit
 * event reflects a real transition.
 */
export function isAllowedRoleChange(currentStatus: MembershipStatus, fromRole: OrganizationRole, toRole: OrganizationRole): boolean {
  return currentStatus === 'ACTIVE' && fromRole !== toRole;
}
