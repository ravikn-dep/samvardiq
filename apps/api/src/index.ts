import { AuthorizationService } from '@samvardiq/identity-access';
import { loadSupabaseConfigFromEnv, SupabaseIdentityProviderAdapter } from '@samvardiq/identity-access/dist/providers/index.js';
import {
  createPostgresClient as createIdentityClient,
  PostgresIdentityRepository,
  PostgresIdentityProviderLinkRepository,
  PostgresMembershipRepository,
} from '@samvardiq/identity-access/dist/postgres/index.js';
import {
  createPostgresClient as createDataFoundationClient,
  PostgresOrganizationRepository,
  PostgresGoalRepository,
} from '@samvardiq/data-foundation/dist/postgres/index.js';
import { GoalReadService } from '@samvardiq/application-services';

import { loadConfigFromEnv } from './config.js';
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

  const identityClient = createIdentityClient();
  const dataFoundationClient = createDataFoundationClient();

  const identities = new PostgresIdentityRepository(identityClient.db);
  const providerLinks = new PostgresIdentityProviderLinkRepository(identityClient.db);
  const memberships = new PostgresMembershipRepository(identityClient.db);
  const authz = new AuthorizationService(identities, providerLinks, memberships);

  const organizations = new PostgresOrganizationRepository(dataFoundationClient.db);
  const goals = new PostgresGoalRepository(dataFoundationClient.db);
  const goalReadService = new GoalReadService(goals);

  const identityProvider = new SupabaseIdentityProviderAdapter(loadSupabaseConfigFromEnv());

  const app = await buildServer({ identityProvider, authz, organizations, goalReadService }, config);

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
      await Promise.allSettled([identityClient.close(), dataFoundationClient.close()]);
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
