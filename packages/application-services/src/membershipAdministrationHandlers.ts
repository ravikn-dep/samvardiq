import type { OrganizationMembership, OrganizationRole } from '@samvardiq/identity-access';
import type { PostgresMembershipAdministrationService } from '@samvardiq/identity-access/dist/postgres/index.js';

import { authenticateRequest, type IncomingRequest, type RequestBoundaryDependencies } from './requestBoundary.js';

export type MembershipAdministrationDependencies = RequestBoundaryDependencies & {
  membershipAdmin: PostgresMembershipAdministrationService;
};

/**
 * IDENTITY-W7 — thin request-boundary handlers, exactly mirroring
 * `protectedGoalListHandler.ts`'s own shape and doc comment: request ->
 * `authenticateRequest` (unmodified from W4) -> the identity-access
 * administration service. No route handler in `apps/api` calls
 * `PostgresMembershipAdministrationService` directly — every write goes
 * through one of these functions, which never decode a JWT, never query
 * membership, never construct `TrustedOrganizationContext` themselves, and
 * never carry business logic (canAdministerMembership/transition validity/
 * last-owner protection all live in identity-access, not here).
 *
 * `requestId` is optional, server-controlled correlation only (section 16)
 * — passed through to the audit event, never treated as authority.
 */

export async function handleCreateInvitedMembershipRequest(
  deps: MembershipAdministrationDependencies,
  request: IncomingRequest,
  input: { targetIdentityId: string; role: OrganizationRole },
  requestId?: string,
): Promise<OrganizationMembership> {
  const context = await authenticateRequest(deps, request);
  return deps.membershipAdmin.createInvitedMembership(context, input, requestId);
}

export async function handleActivateMembershipRequest(
  deps: MembershipAdministrationDependencies,
  request: IncomingRequest,
  targetIdentityId: string,
  requestId?: string,
): Promise<OrganizationMembership> {
  const context = await authenticateRequest(deps, request);
  return deps.membershipAdmin.activateMembership(context, targetIdentityId, requestId);
}

export async function handleReactivateMembershipRequest(
  deps: MembershipAdministrationDependencies,
  request: IncomingRequest,
  targetIdentityId: string,
  requestId?: string,
): Promise<OrganizationMembership> {
  const context = await authenticateRequest(deps, request);
  return deps.membershipAdmin.reactivateMembership(context, targetIdentityId, requestId);
}

export async function handleSuspendMembershipRequest(
  deps: MembershipAdministrationDependencies,
  request: IncomingRequest,
  targetIdentityId: string,
  requestId?: string,
): Promise<OrganizationMembership> {
  const context = await authenticateRequest(deps, request);
  return deps.membershipAdmin.suspendMembership(context, targetIdentityId, requestId);
}

export async function handleRevokeMembershipRequest(
  deps: MembershipAdministrationDependencies,
  request: IncomingRequest,
  targetIdentityId: string,
  requestId?: string,
): Promise<OrganizationMembership> {
  const context = await authenticateRequest(deps, request);
  return deps.membershipAdmin.revokeMembership(context, targetIdentityId, requestId);
}

export async function handleChangeMembershipRoleRequest(
  deps: MembershipAdministrationDependencies,
  request: IncomingRequest,
  targetIdentityId: string,
  toRole: OrganizationRole,
  requestId?: string,
): Promise<OrganizationMembership> {
  const context = await authenticateRequest(deps, request);
  return deps.membershipAdmin.changeRole(context, targetIdentityId, toRole, requestId);
}
