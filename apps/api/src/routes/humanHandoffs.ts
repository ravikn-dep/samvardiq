import type { FastifyInstance } from 'fastify';
import {
  handleClaimHumanHandoffRequest,
  handleListHumanHandoffsRequest,
  handleResolveHumanHandoffRequest,
  type HumanHandoffManagementDependencies,
  type HumanHandoffReadDependencies,
} from '@samvardiq/communication-orchestration';

export type HumanHandoffsRouteDependencies = HumanHandoffReadDependencies & HumanHandoffManagementDependencies;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ID_PATTERN = '^[A-Za-z0-9_-]{1,128}$';

/** The privacy-minimized handoff DTO (W2C), plus the W2D owner fields. `additionalProperties: false` strips anything else. */
const handoffSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: { type: 'string' },
    channelId: { type: 'string' },
    state: { type: 'string' },
    handoffTrigger: { type: 'string' },
    handoffAt: { type: 'string' },
    bookingState: { type: 'string' },
    preferredLanguage: { type: 'string' },
    externalPatientId: { type: 'string' },
    activeEnquiryId: { type: 'string' },
    activeAppointmentId: { type: 'string' },
    handoffOwnerIdentityId: { type: 'string' },
    handoffClaimedAt: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const handoffParamsSchema = {
  type: 'object',
  required: ['organizationId', 'conversationId'],
  additionalProperties: false,
  properties: {
    organizationId: { type: 'string', pattern: ID_PATTERN },
    conversationId: { type: 'string', pattern: ID_PATTERN },
  },
} as const;

/**
 * CLINIC-W2C, section 11. Mirrors `goalsRoute`/`clinicRoute`'s own doc
 * comment exactly: this file extracts transport-shaped values only (the
 * `Authorization` header, the `:organizationId` route param, the
 * `limit`/`cursor` query params) and hands them to the existing
 * `handleListHumanHandoffsRequest` boundary. No JWT decoding, no
 * membership query, no DB access, no role/human-only check, and no
 * pagination logic happens in this file. `limit` is bounded/defaulted by
 * the schema itself (section 20 — native platform validation, not
 * hand-rolled clamping code); an out-of-range or non-integer value fails
 * closed with Fastify's own 400, before this handler ever runs.
 *
 * The GET route is READ-ONLY (section 14): no claim, no reply, no resolve, no AI-resume,
 * no outbound WhatsApp, no CMS call is reachable from this route.
 */
export function humanHandoffsRoute(app: FastifyInstance, deps: HumanHandoffsRouteDependencies): void {
  app.get<{ Params: { organizationId: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/v1/organizations/:organizationId/communication/handoffs',
    {
      schema: {
        params: {
          type: 'object',
          required: ['organizationId'],
          additionalProperties: false,
          properties: {
            organizationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
          },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            // Cursor CONTENT validity (does it decode to the expected shape) is
            // checked by the service layer (InvalidHandoffCursorError) — the
            // schema only bounds its transport size.
            cursor: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              items: { type: 'array', items: handoffSummarySchema },
              nextCursor: { type: 'string' },
            },
          },
        },
      },
    },
    async (request) => {
      return handleListHumanHandoffsRequest(deps, {
        authorizationHeader: request.headers.authorization,
        requestedOrganizationId: request.params.organizationId,
        limit: request.query.limit ?? DEFAULT_LIMIT,
        cursor: request.query.cursor,
      });
    },
  );

  // CLINIC-W2D: claim and resolve. Same thin-plumbing contract as above — authentication, the human OWNER/MEMBER
  // policy, ownership and every state rule live in communication-orchestration's management service, not here.
  app.post<{ Params: { organizationId: string; conversationId: string } }>(
    '/v1/organizations/:organizationId/communication/handoffs/:conversationId/claim',
    { schema: { params: handoffParamsSchema, response: { 200: handoffSummarySchema } } },
    async (request) =>
      handleClaimHumanHandoffRequest(deps, {
        authorizationHeader: request.headers.authorization,
        requestedOrganizationId: request.params.organizationId,
        conversationId: request.params.conversationId,
      }),
  );

  app.post<{ Params: { organizationId: string; conversationId: string }; Body: { outcome: 'RETURN_TO_AI' | 'CLOSE' } }>(
    '/v1/organizations/:organizationId/communication/handoffs/:conversationId/resolve',
    {
      schema: {
        params: handoffParamsSchema,
        body: { type: 'object', required: ['outcome'], additionalProperties: false, properties: { outcome: { type: 'string', enum: ['RETURN_TO_AI', 'CLOSE'] } } },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: { conversationId: { type: 'string' }, state: { type: 'string' }, outcome: { type: 'string' } },
          },
        },
      },
    },
    async (request) =>
      handleResolveHumanHandoffRequest(deps, {
        authorizationHeader: request.headers.authorization,
        requestedOrganizationId: request.params.organizationId,
        conversationId: request.params.conversationId,
        outcome: request.body.outcome,
      }),
  );
}
