/**
 * INFRA-W1B — shared, secret-safe plumbing for the staging migration runner
 * and the staging verifier. Nothing here ever prints, logs or persists the
 * connection string, the password, or a credential-bearing error object.
 */
import { createPostgresClient } from '@samvardiq/data-foundation/dist/postgres/client.js';

/** A deliberate operator-facing refusal whose message is safe to print by construction (never built from credentials or connection strings). */
export class OperatorError extends Error {}

/** Pooler-tenant username the operator confirmed for `samvardiq-staging`. */
export const EXPECTED_STAGING_POOLER_USER = 'postgres.kobkelmeoufdaaesupgf';

/** Both gates must hold before any connection is opened. Never echoes either value beyond a boolean verdict. */
export function requireStagingEnv(): string {
  if (process.env.SAMVARDIQ_DEPLOY_ENV !== 'staging') {
    throw new OperatorError('Refusing to run: SAMVARDIQ_DEPLOY_ENV must be exactly "staging".');
  }
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new OperatorError('Refusing to run: MIGRATION_DATABASE_URL is not set.');
  return connectionString;
}

/** Non-secret target metadata plus a boolean "does the pooler username match the intended project". */
export function describeTarget(connectionString: string): { host: string; port: string; database: string; userMatchesStaging: boolean } {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: url.pathname.replace(/^\//, ''),
    userMatchesStaging: decodeURIComponent(url.username) === EXPECTED_STAGING_POOLER_USER,
  };
}

/** Reduces any thrown value to non-secret fields (SQLSTATE + message of a server-side error only). */
export function sanitizeError(error: unknown): { code?: string; message: string } {
  if (error instanceof OperatorError) return { message: error.message };
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const candidate = cursor as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return { code: candidate.code, message: typeof candidate.message === 'string' ? candidate.message.split('\n')[0]!.slice(0, 200) : 'error' };
    }
    cursor = candidate.cause;
  }
  return { message: error instanceof Error ? error.constructor.name : 'error' };
}

export type AdminPostgres = ReturnType<typeof createPostgresClient>;

/** A small admin pool (owner role). Callers must `close()` it. Reuses data-foundation's typed pg client — apps/api has no direct pg typings. */
export function connectAdmin(connectionString: string): AdminPostgres {
  return createPostgresClient({ connectionString, max: 3, connectionTimeoutMillis: 20_000 });
}

/** Collects named pass/fail checks. Details must be non-secret (catalog facts, SQLSTATEs, counts). */
export class Reporter {
  readonly results: { id: string; ok: boolean; detail?: string }[] = [];

  async check(id: string, fn: () => Promise<string | void>): Promise<void> {
    try {
      const detail = (await fn()) || undefined;
      this.results.push({ id, ok: true, detail });
      console.log(`PASS ${id}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      const sanitized = sanitizeError(error);
      const isAssertion = error instanceof Error && error.name === 'AssertionError';
      const detail = isAssertion ? error.message.split('\n').slice(0, 3).join(' | ').slice(0, 400) : `${sanitized.code ? `[${sanitized.code}] ` : ''}${sanitized.message}`;
      this.results.push({ id, ok: false, detail });
      console.log(`FAIL ${id} — ${detail}`);
    }
  }

  get failed(): number {
    return this.results.filter((r) => !r.ok).length;
  }

  summary(label: string): string {
    return `${label}: ${this.results.length - this.failed}/${this.results.length} checks passed`;
  }
}
