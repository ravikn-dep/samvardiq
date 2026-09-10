import type { FastifyInstance } from 'fastify';
import {
  handleActivateMembershipRequest,
  handleChangeMembershipRoleRequest,
  handleCreateInvitedMembershipRequest,
  handleReactivateMembershipRequest,
  handleRevokeMembershipRequest,
  handleSuspendMembershipRequest,
  type MembershipAdministrationDependencies,
} from '@samvardiq/application-services';

const ID_PATTERN = '^[A-Za-z0-9_-]{1,128}$';
const ROLE_ENUM = ['OWNER', 'MEMBER', 'VIEWER'];

const MEMBERSHIP_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    organizationId: { type: 'string' },
    identityId: { type: 'string' },
    role: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string' },
    activatedAt: { type: 'string' },
    suspendedAt: { type: 'string' },
    revokedAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const ORGANIZATION_ID_PARAM_SCHEMA = { organizationId: { type: 'string', pattern: ID_PATTERN } };
const TARGET_PARAMS_SCHEMA = {
  organizationId: { type: 'string', pattern: ID_PATTERN },
  identityId: { type: 'string', pattern: ID_PATTERN },
};

/**
 * IDENTITY-W7 — purpose-specific write routes only (section 19/AX/AY): no
 * generic `PATCH membership` that accepts an arbitrary status/role. Each
 * route extracts transport-shaped values (Authorization header, route
 * params, a narrowly-schema'd body where one exists) and hands them to the
 * existing `handle*MembershipRequest` boundary in application-services —
 * exactly the same division of responsibility `goals.ts` already
 * establishes. No JWT decoding, no membership query, no DB access, no
 * authorization/policy/transition/last-owner logic in this file; all of
 * that lives in identity-access (built and tested in IDENTITY-W7's own
 * suite) and is reached only through `authenticateRequest` ->
 * `PostgresMembershipAdministrationService`.
 *
 * `:organizationId` is the canonical, sole organization transport (same
 * convention as `goals.ts`) — a request body can never name a different
 * organization because none of these schemas accept an `organizationId`
 * field in the body at all (section 15/J/AE). Likewise no body ever
 * accepts an `actorIdentityId`, `approverRole`, or arbitrary `status`
 * field (section 21/AS) — `additionalProperties: false` on every body
 * schema rejects unknown fields before the handler ever runs.
 */
export function membershipsRoute(app: FastifyInstance, deps: MembershipAdministrationDependencies): void {
  app.post<{ Params: { organizationId: string }; Body: { targetIdentityId: string; role: string } }>(
    '/v1/organizations/:organizationId/memberships',
    {
      schema: {
        params: { type: 'object', required: ['organizationId'], additionalProperties: false, properties: ORGANIZATION_ID_PARAM_SCHEMA },
        body: {
          type: 'object',
          required: ['targetIdentityId', 'role'],
          additionalProperties: false,
          properties: {
            targetIdentityId: { type: 'string', pattern: ID_PATTERN },
            role: { type: 'string', enum: ROLE_ENUM },
          },
        },
        response: { 201: MEMBERSHIP_RESPONSE_SCHEMA },
      },
    },
    async (request, reply) => {
      const membership = await handleCreateInvitedMembershipRequest(
        deps,
        { authorizationHeader: request.headers.authorization, requestedOrganizationId: request.params.organizationId },
        { targetIdentityId: request.body.targetIdentityId, role: request.body.role as never },
        request.id,
      );
      reply.code(201);
      return membership;
    },
  );

  app.post<{ Params: { organizationId: string; identityId: string } }>(
    '/v1/organizations/:organizationId/memberships/:identityId/activate',
    { schema: { params: { type: 'object', required: ['organizationId', 'identityId'], additionalProperties: false, properties: TARGET_PARAMS_SCHEMA }, response: { 200: MEMBERSHIP_RESPONSE_SCHEMA } } },
    async (request) =>
      handleActivateMembershipRequest(
        deps,
        { authorizationHeader: request.headers.authorization, requestedOrganizationId: request.params.organizationId },
        request.params.identityId,
        request.id,
      ),
  );

  app.post<{ Params: { organizationId: string; identityId: string } }>(
    '/v1/organizations/:organizationId/memberships/:identityId/reactivate',
    { schema: { params: { type: 'object', required: ['organizationId', 'identityId'], additionalProperties: false, properties: TARGET_PARAMS_SCHEMA }, response: { 200: MEMBERSHIP_RESPONSE_SCHEMA } } },
    async (request) =>
      handleReactivateMembershipRequest(
        deps,
        { authorizationHeader: request.headers.authorization, requestedOrganizationId: request.params.organizationId },
        request.params.identityId,
        request.id,
      ),
  );

  app.post<{ Params: { organizationId: string; identityId: string } }>(
    '/v1/organizations/:organizationId/memberships/:identityId/suspend',
    { schema: { params: { type: 'object', required: ['organizationId', 'identityId'], additionalProperties: false, properties: TARGET_PARAMS_SCHEMA }, response: { 200: MEMBERSHIP_RESPONSE_SCHEMA } } },
    async (request) =>
      handleSuspendMembershipRequest(
        deps,
        { authorizationHeader: request.headers.authorization, requestedOrganizationId: request.params.organizationId },
        request.params.identityId,
        request.id,
      ),
  );

  app.post<{ Params: { organizationId: string; identityId: string } }>(
    '/v1/organizations/:organizationId/memberships/:identityId/revoke',
    { schema: { params: { type: 'object', required: ['organizationId', 'identityId'], additionalProperties: false, properties: TARGET_PARAMS_SCHEMA }, response: { 200: MEMBERSHIP_RESPONSE_SCHEMA } } },
    async (request) =>
      handleRevokeMembershipRequest(
        deps,
        { authorizationHeader: request.headers.authorization, requestedOrganizationId: request.params.organizationId },
        request.params.identityId,
        request.id,
      ),
  );

  app.patch<{ Params: { organizationId: string; identityId: string }; Body: { role: string } }>(
    '/v1/organizations/:organizationId/memberships/:identityId/role',
    {
      schema: {
        params: { type: 'object', required: ['organizationId', 'identityId'], additionalProperties: false, properties: TARGET_PARAMS_SCHEMA },
        body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { type: 'string', enum: ROLE_ENUM } } },
        response: { 200: MEMBERSHIP_RESPONSE_SCHEMA },
      },
    },
    async (request) =>
      handleChangeMembershipRoleRequest(
        deps,
        { authorizationHeader: request.headers.authorization, requestedOrganizationId: request.params.organizationId },
        request.params.identityId,
        request.body.role as never,
        request.id,
      ),
  );
}
