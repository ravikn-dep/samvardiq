/**
 * Typed, fail-closed configuration boundary (section 32). Deliberately does
 * NOT re-read DATABASE_URL or SUPABASE_PROJECT_URL itself — those already
 * have their own typed loaders (`createPostgresClient` in data-foundation/
 * identity-access reads `DATABASE_URL` directly; `loadSupabaseConfigFromEnv`
 * in identity-access reads `SUPABASE_PROJECT_URL`) and duplicating that logic
 * here would be exactly the kind of redundant config loading Ponytail flags.
 * This module only owns the config that is genuinely this app's own:
 * network binding, CORS, and rate limiting.
 */
export interface ApiConfig {
  port: number;
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
  /** Never `['*']` — an explicit, exact-match allow-list only (section 26). */
  allowedOrigins: string[];
  /** False unless a trusted reverse proxy is explicitly configured (section 30). */
  trustProxy: boolean;
  rateLimit: {
    max: number;
    windowMs: number;
  };
}

export class ConfigError extends Error {}

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of origins) {
    if (origin === '*') {
      throw new ConfigError('ALLOWED_ORIGINS must not contain "*" — list explicit origins.');
    }
    try {
      new URL(origin);
    } catch {
      throw new ConfigError(`ALLOWED_ORIGINS contains a malformed origin: ${JSON.stringify(origin)}`);
    }
  }
  return origins;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`Expected "true" or "false", got ${JSON.stringify(raw)}`);
}

function parseNodeEnv(raw: string | undefined): ApiConfig['nodeEnv'] {
  if (raw === undefined || raw === 'development') return 'development';
  if (raw === 'production' || raw === 'test') return raw;
  throw new ConfigError(`NODE_ENV must be one of development/production/test, got ${JSON.stringify(raw)}`);
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: parsePort(env.PORT),
    host: env.HOST ?? '0.0.0.0',
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    rateLimit: {
      max: env.RATE_LIMIT_MAX ? Number(env.RATE_LIMIT_MAX) : 100,
      windowMs: env.RATE_LIMIT_WINDOW_MS ? Number(env.RATE_LIMIT_WINDOW_MS) : 60_000,
    },
  };
}
