import type { FastifyInstance } from 'fastify';

/**
 * Section 18: liveness only. Deliberately returns nothing beyond a fixed
 * literal — no dependency status, no config, no version/build metadata that
 * could help an attacker fingerprint the deployment.
 */
export function healthRoute(app: FastifyInstance): void {
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string' } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );
}
