import { AuthorizationService } from '@samvardiq/identity-access';
import { loadSupabaseConfigFromEnv, SupabaseIdentityProviderAdapter } from '@samvardiq/identity-access/dist/providers/index.js';
import {
  createPostgresClient as createIdentityClient,
  PostgresIdentityRepository,
  PostgresIdentityProviderLinkRepository,
  PostgresMembershipAdministrationService,
  PostgresMembershipRepository,
} from '@samvardiq/identity-access/dist/postgres/index.js';
import {
  createPostgresClient as createDataFoundationClient,
  PostgresOrganizationRepository,
  PostgresGoalRepository,
} from '@samvardiq/data-foundation/dist/postgres/index.js';
import {
  createPostgresClient as createClinicConnectorClient,
  PostgresClinicCmsConnectionRepository,
  PostgresConnectorAuditRepository,
} from '@samvardiq/clinic-cms-connector/dist/postgres/index.js';
import { EnvConnectorSecretProvider } from '@samvardiq/clinic-cms-connector';
import { GoalReadService } from '@samvardiq/application-services';
import {
  createPostgresClient as createCommsClient,
  PostgresCommunicationChannelRepository,
  PostgresConversationRepository,
  PostgresMessageRepository,
  PostgresMessageContentRepository,
  PostgresWebhookEventDedupRepository,
} from '@samvardiq/communication-orchestration/dist/postgres/index.js';
import { DeterministicCommunicationInterpreter, WhatsAppCloudProvider } from '@samvardiq/communication-orchestration';

import { loadConfigFromEnv } from './config.js';
import { assertRuntimeDatabaseConfigured, assertRuntimeRole } from './runtimeDbIdentity.js';
import { buildServer } from './server.js';

/**
 * Composition root (section 33). Every dependency the server needs is
 * constructed exactly once, here, and injected into `buildServer` — no
 * route handler constructs a database or auth client itself. This is the
 * only file in the repository that reads `DATABASE_URL`/`SUPABASE_PROJECT_URL`
 * indirectly (via each package's own already-existing typed loader) to wire
 * up a real process; test files build their own (in-memory or disposable
 * Postgres) dependency graphs instead of importing this file.
 */
async function main(): Promise<void> {
  const config = loadConfigFromEnv();

  // INFRA-W1D: fail closed before opening a single socket if the runtime
  // database is missing or misconfigured (see runtimeDbIdentity.ts).
  const target = assertRuntimeDatabaseConfigured();

  const identityClient = createIdentityClient();
  const dataFoundationClient = createDataFoundationClient();
  const clinicConnectorClient = createClinicConnectorClient();
  const commsClient = createCommsClient();

  // INFRA-W1D: authoritative, post-connection proof of who this process
  // actually connected as. All four clients read the same DATABASE_URL, so
  // one representative check (via identityClient's pool) speaks for all
  // four. Never logs anything beyond the two non-secret facts it checks.
  const runtimeRole = await assertRuntimeRole(identityClient.pool);
  console.log(`Runtime DB identity confirmed: host=${target.host} database=${runtimeRole.currentDatabase} role=${runtimeRole.currentUser}`);

  const identities = new PostgresIdentityRepository(identityClient.db);
  const providerLinks = new PostgresIdentityProviderLinkRepository(identityClient.db);
  const memberships = new PostgresMembershipRepository(identityClient.db);
  const authz = new AuthorizationService(identities, providerLinks, memberships);
  const membershipAdmin = new PostgresMembershipAdministrationService(identityClient.db, identities);

  const organizations = new PostgresOrganizationRepository(dataFoundationClient.db);
  const goals = new PostgresGoalRepository(dataFoundationClient.db);
  const goalReadService = new GoalReadService(goals);

  const identityProvider = new SupabaseIdentityProviderAdapter(loadSupabaseConfigFromEnv());

  const clinicConnections = new PostgresClinicCmsConnectionRepository(clinicConnectorClient.db);
  const clinicConnectorAudit = new PostgresConnectorAuditRepository(clinicConnectorClient.db);
  // Production secret-store selection is explicitly deferred (CLINIC-W1B status
  // audit, section 12) — env-backed resolution is the interim implementation.
  const clinicSecrets = new EnvConnectorSecretProvider();

  // CLINIC-W2B: same interim env-backed secret resolution, reused rather
  // than inventing a second provider abstraction (ADR-IDENTITY-002).
  const channels = new PostgresCommunicationChannelRepository(commsClient.db);
  const conversations = new PostgresConversationRepository(commsClient.db);
  const messages = new PostgresMessageRepository(commsClient.db);
  const messageContent = new PostgresMessageContentRepository(commsClient.db);
  const dedup = new PostgresWebhookEventDedupRepository(commsClient.db);
  const appSecrets = new EnvConnectorSecretProvider();
  const accessTokenSecrets = new EnvConnectorSecretProvider();
  // A single, platform-level App Secret reference — shared across every
  // channel under this Meta App (see ADR-IDENTITY-002 / channelEventVerifier.ts
  // for why this is deliberately NOT a per-channel value).
  const platformAppSecretReference = 'env:META_WHATSAPP_APP_SECRET';
  const metaWebhookVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';

  const app = await buildServer(
    {
      identityProvider,
      authz,
      organizations,
      goalReadService,
      membershipAdmin,
      clinicConnections,
      clinicConnectorAudit,
      clinicSecrets,
      channels,
      appSecrets,
      platformAppSecretReference,
      dedup,
      clinicDeps: { identityProvider, authz, organizations, clinicConnections, clinicConnectorAudit, clinicSecrets },
      conversations,
      messages,
      messageContent,
      interpreter: new DeterministicCommunicationInterpreter(),
      provider: new WhatsAppCloudProvider(),
      accessTokenSecrets,
      metaWebhookVerifyToken,
    },
    config,
  );

  // Section 31: stop accepting new connections, let in-flight requests
  // finish (fastify.close()'s own default behavior), then release the
  // database pools. No extra shutdown-orchestration library — one signal
  // handler covers both signals a container orchestrator sends.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      await Promise.allSettled([identityClient.close(), dataFoundationClient.close(), clinicConnectorClient.close(), commsClient.close()]);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
