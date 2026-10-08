// GBP-W1 public surface. The Postgres client (migrations, pool-sharing view) is exported for the composition root and migration chain.
export * from './errors.js';
export * from './config.js';
export { GBP_CREDENTIAL_TYPE, GBP_PROVIDER, GBP_SCOPE, GbpReadClient, GoogleOAuthClient, type GbpAccount, type GbpLocation, type HttpFetch } from './google.js';
export * from './connectionService.js';
export * from './handlers.js';
export { createPostgresClient, gbpDatabase, runMigrations, type PostgresClient } from './postgres/client.js';
