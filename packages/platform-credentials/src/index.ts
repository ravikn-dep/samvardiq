// Public surface: the credential boundary, rotation, key ring and errors. The
// envelope primitives and raw tables are deliberately not exported.
export * from './errors.js';
export { MasterKeyRing, MASTER_KEYS_ENV, ACTIVE_KEY_VERSION_ENV } from './keyRing.js';
export * from './credentialService.js';
export * from './keyRotation.js';
export * from './oauthAuthorizations.js';
export { createPostgresClient, runMigrations, type PostgresClient } from './postgres/client.js';
