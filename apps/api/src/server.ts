import crypto from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { classifyError } from '@samvardiq/application-services';

import type { ApiConfig } from './config.js';
import { healthRoute } from './routes/health.js';
import { goalsRoute, type GoalsRouteDependencies } from './routes/goals.js';

/**
 * Composition-root server builder (section 33/17). Takes already-constructed
 * dependencies in — never constructs a database/auth client itself, and
 * never called more than once per process. Framework-boundary rule 1
 * (ARCH-017): this is the only file in the repository allowed to import
 * `fastify`; `application-services`/`identity-access`/`data-foundation`
 * import nothing from here.
 */
export interface BuildServerOptions {
  /** Test-only seam: redirect structured log output for assertion instead of stdout. Never set in production (see index.ts). */
  loggerStream?: NodeJS.WritableStream;
}

export async function buildServer(deps: GoalsRouteDependencies, config: ApiConfig, options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Section 25: request IDs are always server-generated, never trusted from
    // an inbound header (an attacker-controlled request id must never be
    // able to inject arbitrary values into structured logs).
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
    // Section 30: only trust X-Forwarded-* when a reverse proxy is explicitly configured.
    trustProxy: config.trustProxy,
    // Section 22: no route in this session accepts a body; kept small and can
    // be raised per-route (via a route-level `bodyLimit`) once a real
    // request-body endpoint (e.g. a future webhook) is actually added.
    bodyLimit: 16 * 1024,
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      // Section 24: Fastify's default request/response log lines never include
      // headers, but this redaction is kept explicit and verified by test
      // rather than relied on implicitly — see test/security.test.ts.
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
      ...(options.loggerStream ? { stream: options.loggerStream } : {}),
    },
  });

  // Section 29: contentSecurityPolicy/browser-rendering directives are
  // disabled — this is a JSON API that never serves HTML, so shipping a CSP
  // header set here would be the "cargo-cult browser headers" section 29
  // warns against. X-Content-Type-Options is still meaningful for a JSON API
  // (stops a browser from MIME-sniffing a JSON error body as executable
  // content) and is kept.
  await app.register(helmet, { contentSecurityPolicy: false, global: true });

  // Section 26: explicit allow-list only, never `*`. A request with no
  // Origin header (server-to-server, curl, mobile clients) is not a CORS
  // request at all and is always allowed through — CORS is a browser
  // enforcement mechanism, not an authentication boundary (section 27).
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, config.allowedOrigins.includes(origin));
    },
  });

  // Section 28: single-instance, in-memory rate limiting.
  // ponytail: process-local rate limiting, not shared across instances —
  // move the store to Redis (@fastify/rate-limit supports a pluggable
  // store) when horizontal scale makes per-instance limits insufficient.
  //
  // Plugin registration is deliberately awaited (not fire-and-forget) here:
  // an unawaited `fastify.register()` was verified during this session to
  // leave @fastify/rate-limit's global onRequest hook registered (visible
  // in `printPlugins()`) but NOT actually enforced against sibling routes —
  // a real, reproducible Fastify v5 timing hazard, not a style preference.
  await app.register(rateLimit, { max: config.rateLimit.max, timeWindow: config.rateLimit.windowMs });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not Found' });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Fastify's own schema-validation failures (malformed organizationId,
    // unknown query params, etc.) never reach classifyError — they are a
    // transport-level input-hygiene rejection, not a domain error.
    if (error.validation) {
      reply.code(400).send({ error: 'Bad Request' });
      return;
    }
    // Fastify's own well-defined transport-level 4xx errors (oversized body,
    // malformed content-type, etc. — statusCode already < 500, message
    // already generic/safe) are transport hygiene too, not a domain error —
    // classifyError has no branch for these and would otherwise fall through
    // to a misleading 500/"Internal server error."
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    const classified = classifyError(error);
    if (classified.errorClass === 'INTERNAL') {
      // Full error only ever reaches the server-side log, never the client response.
      request.log.error({ err: error }, 'unhandled error');
    }
    reply.code(classified.httpStatus).send({ error: classified.message });
  });

  healthRoute(app);
  goalsRoute(app, deps);

  return app;
}
