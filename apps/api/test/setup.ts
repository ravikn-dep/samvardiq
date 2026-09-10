/**
 * Reuses identity-access's own real-JWT test issuer by relative path, for
 * the same reason application-services' setup.ts already documents: no
 * workspace hoisting exists in this repo, so `jose`'s `customFetch` Symbol
 * must come from identity-access's own `jose` copy to actually override
 * the adapter's internal JWKS fetch.
 */
import {
  AuthorizationService,
  InMemoryIdentityProviderLinkRepository,
  InMemoryIdentityRepository,
  InMemoryMembershipRepository,
} from '@samvardiq/identity-access';
import { SupabaseIdentityProviderAdapter } from '@samvardiq/identity-access/dist/providers/index.js';
import type { MembershipStatus, PrincipalType } from '@samvardiq/identity-access';
import { InMemoryGoalRepository, InMemoryOrganizationRepository } from '@samvardiq/data-foundation';
import { GoalReadService } from '@samvardiq/application-services';

import { buildServer, type BuildServerOptions } from '../src/server.js';
import type { ApiConfig } from '../src/config.js';
import { createTestIssuer, type TestIssuer } from '../../../packages/identity-access/test/jwksTestHelper.js';

export function defaultTestConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    nodeEnv: 'test',
    allowedOrigins: ['https://app.samvardiq.example'],
    trustProxy: false,
    rateLimit: { max: 1000, windowMs: 60_000 },
    ...overrides,
  };
}

type App = Awaited<ReturnType<typeof buildServer>>;

export interface TestWorld {
  app: App;
  issuer: TestIssuer;
  identities: InMemoryIdentityRepository;
  providerLinks: InMemoryIdentityProviderLinkRepository;
  memberships: InMemoryMembershipRepository;
  organizations: InMemoryOrganizationRepository;
  goals: InMemoryGoalRepository;
  authz: AuthorizationService;
  goalReadService: GoalReadService;
}

export async function buildWorld(configOverrides: Partial<ApiConfig> = {}, options: BuildServerOptions = {}): Promise<TestWorld> {
  const identities = new InMemoryIdentityRepository();
  const providerLinks = new InMemoryIdentityProviderLinkRepository();
  const memberships = new InMemoryMembershipRepository(identities);
  const organizations = new InMemoryOrganizationRepository();
  const goals = new InMemoryGoalRepository(organizations);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  const goalReadService = new GoalReadService(goals);
  const issuer = await createTestIssuer();
  const identityProvider = new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions });

  const app = await buildServer({ identityProvider, authz, organizations, goalReadService }, defaultTestConfig(configOverrides), options);
  await app.ready();

  return { app, issuer, identities, providerLinks, memberships, organizations, goals, authz, goalReadService };
}

/** Builds a second app instance over the SAME in-memory world but with an overridden identityProvider/goalReadService (e.g. a simulated provider outage, or a spy service). */
export async function buildAppVariant(
  world: TestWorld,
  overrides: { identityProvider: SupabaseIdentityProviderAdapter; goalReadService?: GoalReadService },
  configOverrides: Partial<ApiConfig> = {},
  options: BuildServerOptions = {},
): Promise<App> {
  return buildServer(
    {
      identityProvider: overrides.identityProvider,
      authz: world.authz,
      organizations: world.organizations,
      goalReadService: overrides.goalReadService ?? world.goalReadService,
    },
    defaultTestConfig(configOverrides),
    options,
  );
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
