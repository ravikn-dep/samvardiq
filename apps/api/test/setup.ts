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
import { InMemoryGoalRepository, InMemoryOrganizationRepository, type OrganizationRepository } from '@samvardiq/data-foundation';
import { EnvConnectorSecretProvider, InMemoryClinicCmsConnectionRepository, InMemoryConnectorAuditRepository } from '@samvardiq/clinic-cms-connector';
import { GoalReadService } from '@samvardiq/application-services';
import type { PostgresMembershipAdministrationService } from '@samvardiq/identity-access/dist/postgres/index.js';
import {
  DeterministicCommunicationInterpreter,
  InMemoryCommunicationChannelRepository,
  InMemoryConversationRepository,
  InMemoryMessageContentRepository,
  InMemoryMessageRepository,
  InMemoryWebhookEventDedupRepository,
  type CommunicationProvider,
} from '@samvardiq/communication-orchestration';

import { buildServer, type BuildServerOptions } from '../src/server.js';
import type { ApiConfig } from '../src/config.js';
import { createTestIssuer, type TestIssuer } from '../../../packages/identity-access/test/jwksTestHelper.js';

/**
 * The goals/health/security/config test suites in this file never exercise
 * the membership-administration routes — those are proven against a real
 * Postgres-backed `PostgresMembershipAdministrationService` in
 * test/integration/memberships.test.ts (section 32: never mock the
 * transaction/authorization boundary a test actually claims). This stub
 * exists only to satisfy `buildServer`'s dependency type for the unrelated
 * tests in this file; any accidental call fails loudly rather than
 * silently returning a fake result.
 */
function unusedMembershipAdminStub(): PostgresMembershipAdministrationService {
  const notImplemented = () => {
    throw new Error('membershipAdmin is not wired in this test world — see test/integration/memberships.test.ts');
  };
  return {
    createInvitedMembership: notImplemented,
    activateMembership: notImplemented,
    reactivateMembership: notImplemented,
    suspendMembership: notImplemented,
    revokeMembership: notImplemented,
    changeRole: notImplemented,
  } as unknown as PostgresMembershipAdministrationService;
}

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
  clinicConnections: InMemoryClinicCmsConnectionRepository;
  clinicConnectorAudit: InMemoryConnectorAuditRepository;
  channels: InMemoryCommunicationChannelRepository;
  conversations: InMemoryConversationRepository;
}

/**
 * A non-network outbound provider double for THIS file's fixtures — the
 * real `WhatsAppCloudProvider`'s actual HTTP request shape is already
 * exhaustively proven in `communication-orchestration`'s own
 * `communicationProvider.test.ts`; these apps/api-level tests exercise
 * Fastify plumbing (the route/webhook boundary), not outbound HTTP
 * behavior, and must never attempt a real network call to Meta.
 */
class FakeCommunicationProvider implements CommunicationProvider {
  async sendSessionMessage() {
    return { externalMessageId: 'wamid.test-out' };
  }
  async sendTemplateMessage() {
    return { externalMessageId: 'wamid.test-out' };
  }
}

/** CLINIC-W2B: the goals/health/security/config/membership test suites in this file (and the real-Postgres integration suites, which reuse this) never exercise the WhatsApp webhook route — built once here purely to satisfy `buildServer`'s dependency type. */
export function commsDeps(shared: {
  authz: AuthorizationService;
  organizations: OrganizationRepository;
  clinicConnections: InMemoryClinicCmsConnectionRepository;
  clinicConnectorAudit: InMemoryConnectorAuditRepository;
  channels: InMemoryCommunicationChannelRepository;
  conversations: InMemoryConversationRepository;
}) {
  const clinicSecrets = new EnvConnectorSecretProvider();
  return {
    channels: shared.channels,
    appSecrets: new EnvConnectorSecretProvider({ META_APP_SECRET: 'test-only-app-secret-at-least-32-chars' }),
    platformAppSecretReference: 'env:META_APP_SECRET',
    dedup: new InMemoryWebhookEventDedupRepository(),
    clinicDeps: {
      identityProvider: undefined as never,
      authz: shared.authz,
      organizations: shared.organizations,
      clinicConnections: shared.clinicConnections,
      clinicConnectorAudit: shared.clinicConnectorAudit,
      clinicSecrets,
    },
    conversations: shared.conversations,
    messages: new InMemoryMessageRepository(),
    messageContent: new InMemoryMessageContentRepository(),
    interpreter: new DeterministicCommunicationInterpreter(),
    provider: new FakeCommunicationProvider(),
    accessTokenSecrets: new EnvConnectorSecretProvider({ TOKEN: 'test-only-access-token-value' }),
    metaWebhookVerifyToken: 'test-verify-token',
  };
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
  const clinicConnections = new InMemoryClinicCmsConnectionRepository();
  const clinicConnectorAudit = new InMemoryConnectorAuditRepository();
  const clinicSecrets = new EnvConnectorSecretProvider();
  const channels = new InMemoryCommunicationChannelRepository();
  const conversations = new InMemoryConversationRepository();

  const app = await buildServer(
    {
      identityProvider,
      authz,
      organizations,
      goalReadService,
      membershipAdmin: unusedMembershipAdminStub(),
      clinicConnections,
      clinicConnectorAudit,
      clinicSecrets,
      ...commsDeps({ authz, organizations, clinicConnections, clinicConnectorAudit, channels, conversations }),
    },
    defaultTestConfig(configOverrides),
    options,
  );
  await app.ready();

  return { app, issuer, identities, providerLinks, memberships, organizations, goals, authz, goalReadService, clinicConnections, clinicConnectorAudit, channels, conversations };
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
      membershipAdmin: unusedMembershipAdminStub(),
      clinicConnections: world.clinicConnections,
      clinicConnectorAudit: world.clinicConnectorAudit,
      clinicSecrets: new EnvConnectorSecretProvider(),
      ...commsDeps({ authz: world.authz, organizations: world.organizations, clinicConnections: world.clinicConnections, clinicConnectorAudit: world.clinicConnectorAudit, channels: world.channels, conversations: world.conversations }),
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
