import type { FastifyInstance } from 'fastify';
import {
  handleGbpBeginAuthorizationRequest,
  handleGbpBindRequest,
  handleGbpCompleteAuthorizationRequest,
  handleGbpDisconnectRequest,
  handleGbpStatusRequest,
  handleGbpUnbindRequest,
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
  binding: nullable({
    type: 'object',
    additionalProperties: false,
    properties: { locationName: { type: 'string' }, accountName: { type: 'string' }, title: { type: 'string' }, boundByIdentityId: { type: 'string' }, boundAt: { type: 'string' } },
  }),
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

  app.post<{ Params: { organizationId: string }; Body: { locationName: string } }>(
    `${BASE}/binding`,
    {
      schema: {
        params: PARAMS,
        body: { type: 'object', required: ['locationName'], additionalProperties: false, properties: { locationName: { type: 'string', pattern: '^locations/[A-Za-z0-9_-]{1,64}$' } } },
        response: { 200: STATUS },
      },
    },
    async (request) => handleGbpBindRequest(d, req(request), request.body.locationName),
  );

  app.delete<{ Params: { organizationId: string } }>(`${BASE}/binding`, { schema: { params: PARAMS, response: { 200: STATUS } } }, async (request) => handleGbpUnbindRequest(d, req(request)));

  app.post<{ Params: { organizationId: string } }>(
    `${BASE}/disconnect`,
    { schema: { params: PARAMS, response: { 200: { type: 'object', additionalProperties: false, properties: { ...STATUS_PROPERTIES, googleAuthorization: { type: 'string' } } } } } },
    async (request) => handleGbpDisconnectRequest(d, req(request)),
  );
}
