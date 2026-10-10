import type { FastifyInstance } from 'fastify';
import {
  handleGbpBeginAuthorizationRequest,
  handleGbpBindRequest,
  handleGbpCompleteAuthorizationRequest,
  handleGbpDisconnectRequest,
  handleGbpRefreshDiscoveryRequest,
  handleGbpStatusRequest,
  handleGbpUnbindRequest,
  handleGbpVerifyRequest,
  type GbpRouteDependencies,
} from '@samvardiq/google-business-profile';

export type GoogleBusinessProfileRouteDependencies = Omit<GbpRouteDependencies, 'gbp'> & Partial<Pick<GbpRouteDependencies, 'gbp'>>;

const BASE = '/v1/organizations/:organizationId/integrations/google-business-profile';
const PARAMS = {
  type: 'object',
  required: ['organizationId'],
  additionalProperties: false,
  properties: { organizationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
} as const;

const nullable = (schema: object) => ({ anyOf: [{ type: 'null' }, schema] });

/** Response schemas strip anything not listed (additionalProperties: false) — the OWNER only ever receives non-secret metadata. */
const STATUS_PROPERTIES = {
  connection: nullable({
    type: 'object',
    additionalProperties: false,
    properties: {
      connectionId: { type: 'string' },
      status: { type: 'string' },
      googleAccountId: { type: ['string', 'null'] },
      grantedScopes: { type: 'array', items: { type: 'string' } },
      connectedAt: { type: 'string' },
      updatedAt: { type: 'string' },
    },
  }),
  bindings: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationName: { type: 'string' },
        accountName: { type: 'string' },
        title: { type: 'string' },
        boundByIdentityId: { type: 'string' },
        boundAt: { type: 'string' },
        accessLostAt: { type: ['string', 'null'] },
      },
    },
  },
  candidates: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: { locationName: { type: 'string' }, accountName: { type: 'string' }, accountDisplayName: { type: 'string' }, title: { type: 'string' }, addressSummary: { type: ['string', 'null'] } },
    },
  },
} as const;
const STATUS = { type: 'object', additionalProperties: false, properties: STATUS_PROPERTIES } as const;
const LOCATION_PARAMS = {
  type: 'object',
  required: ['organizationId', 'locationId'],
  additionalProperties: false,
  properties: { ...PARAMS.properties, locationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
} as const;

/**
 * GBP-W1 — OWNER-only Google Business Profile connection administration.
 * Transport only, like every other route file: the Authorization header and
 * `:organizationId` go to the package's request-boundary handlers, which
 * authenticate fresh and require a human OWNER. No body ever names an
 * organization or identity (additionalProperties: false → 400).
 *
 * G4-A: Google redirects to the Samvardiq web app (or the operator's
 * loopback proof), which POSTs `{state, code}` here WITH the OWNER's session —
 * there is deliberately no unauthenticated GET callback on the API. The code
 * and state travel only in request bodies, which are never logged.
 */
export function googleBusinessProfileRoute(app: FastifyInstance, deps: GoogleBusinessProfileRouteDependencies): void {
  const d: GbpRouteDependencies = { ...deps, gbp: deps.gbp ?? null };
  const req = (request: { headers: { authorization?: string | string[] }; params: { organizationId: string } }) => ({
    authorizationHeader: request.headers.authorization,
    requestedOrganizationId: request.params.organizationId,
  });

  app.get<{ Params: { organizationId: string } }>(BASE, { schema: { params: PARAMS, response: { 200: STATUS } } }, async (request) => handleGbpStatusRequest(d, req(request)));

  app.post<{ Params: { organizationId: string }; Body: { redirectUri: string } }>(
    `${BASE}/authorizations`,
    {
      schema: {
        params: PARAMS,
        body: { type: 'object', required: ['redirectUri'], additionalProperties: false, properties: { redirectUri: { type: 'string', minLength: 1, maxLength: 512 } } },
        response: { 201: { type: 'object', additionalProperties: false, properties: { authorizationUrl: { type: 'string' }, expiresAt: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const result = await handleGbpBeginAuthorizationRequest(d, req(request), request.body.redirectUri);
      reply.code(201);
      return result;
    },
  );

  app.post<{ Params: { organizationId: string }; Body: { state: string; code?: string; error?: string } }>(
    `${BASE}/authorizations/complete`,
    {
      schema: {
        params: PARAMS,
        body: {
          type: 'object',
          required: ['state'],
          additionalProperties: false,
          properties: {
            state: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
            code: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[\\x21-\\x7e]+$' },
            error: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-z_]+$' },
          },
          oneOf: [{ required: ['code'] }, { required: ['error'] }],
        },
        response: { 200: STATUS },
      },
    },
    async (request) => handleGbpCompleteAuthorizationRequest(d, req(request), request.body),
  );

  // G1: OWNER-requested provider operations, executed by the organization's GBP service principal.
  app.post<{ Params: { organizationId: string } }>(`${BASE}/discovery`, { schema: { params: PARAMS, response: { 200: STATUS } } }, async (request) => handleGbpRefreshDiscoveryRequest(d, req(request)));

  app.post<{ Params: { organizationId: string } }>(
    `${BASE}/verify`,
    { schema: { params: PARAMS, response: { 200: { type: 'object', additionalProperties: false, properties: { ...STATUS_PROPERTIES, health: { type: 'string' }, checkedAt: { type: 'string' } } } } } },
    async (request) => handleGbpVerifyRequest(d, req(request)),
  );

  // G3: several locations per organization, each an explicit, confirmed OWNER choice.
  app.post<{ Params: { organizationId: string }; Body: { locationNames: string[]; confirm: true } }>(
    `${BASE}/bindings`,
    {
      schema: {
        params: PARAMS,
        body: {
          type: 'object',
          required: ['locationNames', 'confirm'],
          additionalProperties: false,
          properties: {
            locationNames: { type: 'array', minItems: 1, maxItems: 25, uniqueItems: true, items: { type: 'string', pattern: '^locations/[A-Za-z0-9_-]{1,64}$' } },
            confirm: { const: true },
          },
        },
        response: { 200: STATUS },
      },
    },
    async (request) => handleGbpBindRequest(d, req(request), request.body),
  );

  app.delete<{ Params: { organizationId: string; locationId: string } }>(
    `${BASE}/bindings/:locationId`,
    { schema: { params: LOCATION_PARAMS, response: { 200: STATUS } } },
    async (request) => handleGbpUnbindRequest(d, req(request), `locations/${request.params.locationId}`),
  );

  app.post<{ Params: { organizationId: string }; Body: { revokeGoogleAccess: boolean } }>(
    `${BASE}/disconnect`,
    {
      schema: {
        params: PARAMS,
        body: { type: 'object', required: ['revokeGoogleAccess'], additionalProperties: false, properties: { revokeGoogleAccess: { type: 'boolean' } } },
        response: { 200: { type: 'object', additionalProperties: false, properties: { ...STATUS_PROPERTIES, googleRevocation: { type: 'string' } } } },
      },
    },
    async (request) => handleGbpDisconnectRequest(d, req(request), request.body),
  );
}
