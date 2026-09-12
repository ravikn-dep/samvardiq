import type { FastifyInstance } from 'fastify';
import { handleListMyOrganizationsRequest, type RequestBoundaryDependencies } from '@samvardiq/application-services';

/**
 * IDENTITY-W8 — pre-organization discovery (section 10). The router's
 * ONLY job is extracting the Authorization header and handing it to
 * `handleListMyOrganizationsRequest` — no JWT decoding, no membership
 * query, no DB access, no role inference here, exactly like every other
 * route in this app. This route deliberately does NOT take an
 * `:organizationId` param — it exists precisely to answer "which
 * organizations may I select?" BEFORE one is chosen (section 7).
 *
 * Response is a plain array of `{organizationId, name, role}` — never a
 * TrustedOrganizationContext-shaped object, never provider subject,
 * audit data, or ApproverRole (section 10). An identity with zero
 * eligible organizations (unprovisioned, inactive, or genuinely
 * membership-less) gets the identical `200 []` — see
 * organizationDiscoveryHandler.ts for the full non-enumeration reasoning.
 */
export function meRoute(app: FastifyInstance, deps: RequestBoundaryDependencies): void {
  app.get(
    '/v1/me/organizations',
    {
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                organizationId: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request) => {
      return handleListMyOrganizationsRequest(deps, { authorizationHeader: request.headers.authorization });
    },
  );
}
