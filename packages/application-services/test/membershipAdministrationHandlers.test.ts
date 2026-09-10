import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PostgresMembershipAdministrationService } from '@samvardiq/identity-access/dist/postgres/index.js';

import {
  handleActivateMembershipRequest,
  handleChangeMembershipRoleRequest,
  handleCreateInvitedMembershipRequest,
  handleReactivateMembershipRequest,
  handleRevokeMembershipRequest,
  handleSuspendMembershipRequest,
} from '../src/membershipAdministrationHandlers.js';
import { assertDenied, buildWorld, provisionMember } from './setup.js';

/**
 * E-H at this layer (authentication failures never reach the
 * administration service — the same "protected service never invoked"
 * proof `requestBoundary.test.ts`/`composition.test.ts` already establish
 * for goal reads, mirrored here for every write operation) plus a
 * threading check (AB/AC: the exact `TrustedOrganizationContext` produced
 * by `authenticateRequest` reaches the service, never re-derived).
 *
 * The administration service itself is a hand-rolled spy here, not the
 * real `PostgresMembershipAdministrationService` — its actual behavior
 * (policy, transitions, atomic audit, concurrency) is proven against real
 * PostgreSQL in identity-access's own test suite (section 32: do not
 * mock the boundary being claimed — this suite claims only "the request
 * boundary calls the right method with the right actor," not "the
 * service behaves correctly").
 */

function spyMembershipAdmin() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ organizationId: 'org-A', identityId: 'target-1', role: 'MEMBER', status: 'ACTIVE' } as never);
    };
  const admin = {
    createInvitedMembership: record('createInvitedMembership'),
    activateMembership: record('activateMembership'),
    reactivateMembership: record('reactivateMembership'),
    suspendMembership: record('suspendMembership'),
    revokeMembership: record('revokeMembership'),
    changeRole: record('changeRole'),
  } as unknown as PostgresMembershipAdministrationService;
  return { admin, calls };
}

test('E: no Authorization header fails closed and never invokes membership administration', async () => {
  const world = await buildWorld();
  const { admin, calls } = spyMembershipAdmin();
  await assertDenied(
    handleCreateInvitedMembershipRequest(
      { ...world.deps, membershipAdmin: admin },
      { authorizationHeader: undefined, requestedOrganizationId: 'org-A' },
      { targetIdentityId: 'target-1', role: 'MEMBER' },
    ),
    'UNAUTHENTICATED',
  );
  assert.equal(calls.length, 0);
});

test('F: an invalid token fails closed and never invokes membership administration', async () => {
  const world = await buildWorld();
  const { admin, calls } = spyMembershipAdmin();
  await assertDenied(
    handleSuspendMembershipRequest(
      { ...world.deps, membershipAdmin: admin },
      { authorizationHeader: 'Bearer not-a-real-jwt', requestedOrganizationId: 'org-A' },
      'target-1',
    ),
    'UNAUTHENTICATED',
  );
  assert.equal(calls.length, 0);
});

test('G: an expired token fails closed and never invokes membership administration', async () => {
  const world = await buildWorld();
  const { admin, calls } = spyMembershipAdmin();
  const token = await world.issuer.signToken({ expiresInSeconds: -3600 });
  await assertDenied(
    handleRevokeMembershipRequest({ ...world.deps, membershipAdmin: admin }, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' }, 'target-1'),
    'UNAUTHENTICATED',
  );
  assert.equal(calls.length, 0);
});

test('H: an Org A member requesting to administer Org B is denied before membership administration is ever invoked', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A' });
  await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
  const { admin, calls } = spyMembershipAdmin();
  const token = await world.issuer.signToken({ sub: 'sub-1' });

  await assertDenied(
    handleActivateMembershipRequest({ ...world.deps, membershipAdmin: admin }, { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-B' }, 'target-1'),
    'FORBIDDEN',
  );
  assert.equal(calls.length, 0);
});

test('AB/AC: the exact TrustedOrganizationContext resolved by authentication reaches the administration service unchanged', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-owner', subject: 'sub-owner', organizationId: 'org-A', role: 'OWNER' });
  const { admin, calls } = spyMembershipAdmin();
  const token = await world.issuer.signToken({ sub: 'sub-owner' });

  await handleChangeMembershipRoleRequest(
    { ...world.deps, membershipAdmin: admin },
    { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' },
    'target-1',
    'VIEWER',
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'changeRole');
  const [context, targetId, toRole] = calls[0]!.args as [{ identityId: string; organizationId: string; role: string }, string, string];
  assert.equal(context.identityId, 'id-owner');
  assert.equal(context.organizationId, 'org-A');
  assert.equal(context.role, 'OWNER');
  assert.equal(targetId, 'target-1');
  assert.equal(toRole, 'VIEWER');
});

test('all six operations authenticate before delegating, and delegate to their own distinct method', async () => {
  const world = await buildWorld();
  await provisionMember(world, { identityId: 'id-owner', subject: 'sub-owner', organizationId: 'org-A', role: 'OWNER' });
  const { admin, calls } = spyMembershipAdmin();
  const token = await world.issuer.signToken({ sub: 'sub-owner' });
  const req = { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: 'org-A' };

  await handleCreateInvitedMembershipRequest({ ...world.deps, membershipAdmin: admin }, req, { targetIdentityId: 't', role: 'MEMBER' });
  await handleActivateMembershipRequest({ ...world.deps, membershipAdmin: admin }, req, 't');
  await handleReactivateMembershipRequest({ ...world.deps, membershipAdmin: admin }, req, 't');
  await handleSuspendMembershipRequest({ ...world.deps, membershipAdmin: admin }, req, 't');
  await handleRevokeMembershipRequest({ ...world.deps, membershipAdmin: admin }, req, 't');
  await handleChangeMembershipRoleRequest({ ...world.deps, membershipAdmin: admin }, req, 't', 'VIEWER');

  assert.deepEqual(
    calls.map((c) => c.method),
    ['createInvitedMembership', 'activateMembership', 'reactivateMembership', 'suspendMembership', 'revokeMembership', 'changeRole'],
  );
});
