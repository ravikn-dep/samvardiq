/**
 * Imports identity-access's own `test/jwksTestHelper.ts` by relative path
 * rather than duplicating it (section 32: "reuse W3's proven adapter
 * fixtures"). This is not just a style choice: this monorepo has no
 * workspace hoisting (no root package.json), so each package's `npm
 * install` produces a physically separate `node_modules/jose`. `jose`'s
 * `customFetch` override is matched by Symbol identity — a `customFetch`
 * obtained from THIS package's own `jose` copy would be a different
 * Symbol than the one identity-access's compiled adapter checks against
 * internally, so it would silently fail to override the fetch and the
 * adapter would attempt a real network call instead (confirmed by
 * reproducing this exact failure during development of this test suite).
 * Importing the helper file by relative path makes its own `import
 * ... from 'jose'` resolve from identity-access's own directory, picking
 * up the SAME `jose` instance the adapter uses — the only way to get a
 * matching Symbol without introducing repo-wide dependency hoisting
 * (out of scope for this session).
 */
import {
  AuthorizationService,
  InMemoryIdentityProviderLinkRepository,
  InMemoryIdentityRepository,
  InMemoryMembershipRepository,
} from '@samvardiq/identity-access';
import { SupabaseIdentityProviderAdapter } from '@samvardiq/identity-access/dist/providers/index.js';
import { InMemoryGoalRepository, InMemoryOrganizationRepository } from '@samvardiq/data-foundation';
import type { MembershipStatus, PrincipalType } from '@samvardiq/identity-access';

import { classifyError, type ErrorClass } from '../src/errors.js';
import { GoalReadService } from '../src/goalReadService.js';
import type { RequestBoundaryDependencies } from '../src/requestBoundary.js';
import { createTestIssuer, type TestIssuer } from '../../identity-access/test/jwksTestHelper.js';
import assert from 'node:assert/strict';

export interface TestWorld {
  identities: InMemoryIdentityRepository;
  providerLinks: InMemoryIdentityProviderLinkRepository;
  memberships: InMemoryMembershipRepository;
  organizations: InMemoryOrganizationRepository;
  goals: InMemoryGoalRepository;
  authz: AuthorizationService;
  goalReadService: GoalReadService;
  issuer: TestIssuer;
  deps: RequestBoundaryDependencies & { goalReadService: GoalReadService };
}

export async function buildWorld(): Promise<TestWorld> {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const organizations = new InMemoryOrganizationRepository();
  const goals = new InMemoryGoalRepository(organizations);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  const goalReadService = new GoalReadService(goals);
  const issuer = await createTestIssuer();
  const identityProvider = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });

  return {
    identities,
    providerLinks,
    memberships,
    organizations,
    goals,
    authz,
    goalReadService,
    issuer,
    deps: { identityProvider, authz, organizations, goalReadService },
  };
}

/**
 * A bare `assert.rejects(promise)` passes on ANY rejection, including a
 * wrong-kind failure that happens to also throw (this exact gap
 * previously let a broken test-fixture module-duplication bug pass
 * silently — see setup.ts's own doc comment above). Every adversarial
 * test in this suite that expects a denial asserts the specific
 * `ErrorClass` the request boundary's own `classifyError` assigns it,
 * not merely "something threw."
 */
export async function assertDenied(promise: Promise<unknown>, expectedClass: ErrorClass): Promise<void> {
  try {
    await promise;
    assert.fail('expected the request to be denied, but it succeeded');
  } catch (error) {
    assert.equal(classifyError(error).errorClass, expectedClass);
  }
}

export async function provisionMember(
  world: TestWorld,
  opts: {
    identityId: string;
    subject: string;
    organizationId: string;
    membershipStatus?: MembershipStatus;
    principalType?: PrincipalType;
    role?: 'OWNER' | 'MEMBER' | 'VIEWER';
  },
): Promise<void> {
  await world.identities.create({ identityId: opts.identityId, principalType: opts.principalType ?? 'human', displayName: opts.identityId });
  await world.providerLinks.create({ identityId: opts.identityId, provider: 'supabase', providerSubject: opts.subject });
  await world.organizations.create({ organizationId: opts.organizationId, organizationType: 'clinic', name: opts.organizationId });
  await world.memberships.create({
    organizationId: opts.organizationId,
    identityId: opts.identityId,
    role: opts.role ?? 'MEMBER',
    status: opts.membershipStatus ?? 'ACTIVE',
  });
}
