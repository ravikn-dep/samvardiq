import type { FastifyInstance } from 'fastify';
import { handleListGoalsRequest, type GoalReadService, type RequestBoundaryDependencies } from '@samvardiq/application-services';

export type GoalsRouteDependencies = RequestBoundaryDependencies & { goalReadService: GoalReadService };

/**
 * Section 19/20: the router's ONLY job is extracting two transport-shaped
 * values (the `Authorization` header, the `:organizationId` route param) and
 * handing them to the existing, unmodified `handleListGoalsRequest` boundary.
 * The route param is the canonical organization transport (section 20) — the
 * legacy `x-samvardiq-organization-id` header from IDENTITY-W4 is never read
 * here, so it cannot conflict with or override the route param; one
 * canonical mechanism, not two reconciled ones.
 *
 * No JWT decoding, no membership query, no DB access, no role inference
 * happens in this file — every one of those already happens inside
 * `handleListGoalsRequest` -> `authenticateRequest` -> `AuthorizationService`,
 * built and tested in IDENTITY-W2/W3/W4 (ARCH-016). This file only proves the
 * plumbing.
 */
export function goalsRoute(app: FastifyInstance, deps: GoalsRouteDependencies): void {
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/goals',
    {
      schema: {
        params: {
          type: 'object',
          required: ['organizationId'],
          additionalProperties: false,
          properties: {
            // Bounded, safe-charset organizationId (section 21) — input hygiene only, never authorization.
            organizationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                goalId: { type: 'string' },
                organizationId: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                status: { type: 'string' },
                ownerExecutive: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request) => {
      return handleListGoalsRequest(deps, {
        authorizationHeader: request.headers.authorization,
        requestedOrganizationId: request.params.organizationId,
      });
    },
  );
}
