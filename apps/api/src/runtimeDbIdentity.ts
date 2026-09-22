/**
 * INFRA-W1D — the deployed apps/api's own runtime-database identity guard.
 *
 * `DATABASE_URL` is the pre-existing, already-documented convention (each
 * package's own `createPostgresClient()` reads it directly; the Supabase
 * staging runbook's §9 already names it "the runtime, samvardiq_app-scoped
 * connection string", distinct from `MIGRATION_DATABASE_URL`). This module
 * adds the two checks nothing in the repository performed before now:
 *
 * 1. Fail closed BEFORE opening any connection if `DATABASE_URL` is absent,
 *    or is byte-identical to `MIGRATION_DATABASE_URL` (the single cheapest
 *    guard against the most likely operator mistake: copying the admin
 *    connection string into the runtime slot). Without this, a missing
 *    `DATABASE_URL` would fall through to `pg`'s own libpq-style environment
 *    fallback (`PGHOST`/`PGUSER`/...) or OS defaults — silently connecting
 *    somewhere unintended instead of refusing to start.
 * 2. AFTER connecting, authoritatively re-derive who the session actually is
 *    from Postgres itself — never trust the connection string's own
 *    username — and refuse to start unless it is exactly `samvardiq_app`
 *    with none of the dangerous role attributes DATA-W3/INFRA-W1B already
 *    established it must never have. This is the same shape of proof
 *    `structureChecks.ts`'s S3 already performs against staging; here it
 *    runs once, locally, against whatever database the deployed process is
 *    actually pointed at, non-secretly (only `current_user`/
 *    `current_database` are ever logged — never the connection string).
 *
 * Deliberately NOT in `createPostgresClient()` itself (in each of the four
 * packages): that function is shared by every test harness in the
 * repository, many of which legitimately connect as other roles (the
 * migration/owner role) for setup — adding a hard `samvardiq_app`-only
 * assertion there would break every existing integration test. This guard
 * belongs only to `apps/api`'s own composition root, which is the one place
 * in the repository that is supposed to run as the runtime role and nothing
 * else.
 */
export class RuntimeDatabaseIdentityError extends Error {}

const EXPECTED_RUNTIME_ROLE = 'samvardiq_app';

export interface RuntimeRoleAttributes {
  currentUser: string;
  currentDatabase: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
}

/** Non-secret target description — host/port/database only, never username or password. Safe to log. */
export interface RuntimeTarget {
  host: string;
  port: string;
  database: string;
}

/** Pre-connection, fail-closed checks. Cheap, and catches the most likely operator mistake before ever opening a socket. */
export function assertRuntimeDatabaseConfigured(env: NodeJS.ProcessEnv = process.env): RuntimeTarget {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new RuntimeDatabaseIdentityError('DATABASE_URL is not set. apps/api refuses to start without an explicit runtime database connection string — there is no local/insecure default.');
  }
  if (env.MIGRATION_DATABASE_URL && env.MIGRATION_DATABASE_URL === databaseUrl) {
    throw new RuntimeDatabaseIdentityError('DATABASE_URL is identical to MIGRATION_DATABASE_URL. The deployed API must never run as the migration/admin identity — refusing to start.');
  }
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new RuntimeDatabaseIdentityError('DATABASE_URL is not a valid connection URL.');
  }
  return { host: url.hostname, port: url.port || '5432', database: url.pathname.replace(/^\//, '') };
}

/** The authoritative, post-connection proof: query the real session, never trust the connection string alone. */
export async function assertRuntimeRole(queryable: { query(text: string): Promise<{ rows: unknown[] }> }): Promise<RuntimeRoleAttributes> {
  const { rows } = await queryable.query(
    `select current_user as "currentUser", current_database() as "currentDatabase",
            rolsuper as "rolsuper", rolbypassrls as "rolbypassrls", rolcreatedb as "rolcreatedb",
            rolcreaterole as "rolcreaterole", rolreplication as "rolreplication"
       from pg_roles where rolname = current_user`,
  );
  const attrs = rows[0] as RuntimeRoleAttributes | undefined;
  if (!attrs) throw new RuntimeDatabaseIdentityError('Could not read the connected role’s own pg_roles row.');
  if (attrs.currentUser !== EXPECTED_RUNTIME_ROLE) {
    throw new RuntimeDatabaseIdentityError(`Connected as "${attrs.currentUser}", expected "${EXPECTED_RUNTIME_ROLE}". Refusing to start: this looks like a migration/admin credential, not the governed runtime role.`);
  }
  if (attrs.rolsuper || attrs.rolbypassrls || attrs.rolcreatedb || attrs.rolcreaterole || attrs.rolreplication) {
    throw new RuntimeDatabaseIdentityError(`"${attrs.currentUser}" holds an unexpected elevated attribute (super/bypassrls/createdb/createrole/replication). Refusing to start.`);
  }
  return attrs;
}
