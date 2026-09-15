import type { FastifyInstance } from 'fastify';
import { handleGetClinicAvailableSlotsRequest, handleListClinicConsultantsRequest, type ClinicOperationsDependencies } from '@samvardiq/application-services';

export type ClinicRouteDependencies = ClinicOperationsDependencies;

/**
 * CLINIC-W1B-2, section 23/31: the protected read slice only. Mirrors
 * `goalsRoute`'s own doc comment exactly — this file extracts transport-shaped
 * values (the `Authorization` header, the `:organizationId`/`:consultantId`
 * route params, the `date` query param) and hands them to the existing
 * `handleListClinicConsultantsRequest`/`handleGetClinicAvailableSlotsRequest`
 * boundary. No HMAC, no secret resolution, no CMS HTTP call, no
 * TrustedOrganizationContext construction, and no connector business logic
 * happens in this file (section 23's explicit "routes must remain thin").
 *
 * Write capabilities (patient registration, enquiry/appointment creation,
 * reschedule, cancel) exist at the application-service/connector layer
 * (section 24) but are deliberately NOT exposed as routes here — W1B-2 is
 * connector foundation, not booking UI.
 */
export function clinicRoute(app: FastifyInstance, deps: ClinicRouteDependencies): void {
  app.get<{ Params: { organizationId: string } }>(
    '/v1/organizations/:organizationId/clinic/consultants',
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
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                externalConsultantId: { type: 'string' },
                displayName: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request) => {
      return handleListClinicConsultantsRequest(deps, {
        authorizationHeader: request.headers.authorization,
        requestedOrganizationId: request.params.organizationId,
      });
    },
  );

  app.get<{ Params: { organizationId: string; consultantId: string }; Querystring: { date: string } }>(
    '/v1/organizations/:organizationId/clinic/consultants/:consultantId/slots',
    {
      schema: {
        params: {
          type: 'object',
          required: ['organizationId', 'consultantId'],
          additionalProperties: false,
          properties: {
            organizationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
            consultantId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
          },
        },
        querystring: {
          type: 'object',
          required: ['date'],
          additionalProperties: false,
          properties: {
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              externalConsultantId: { type: 'string' },
              date: { type: 'string' },
              timezone: { type: 'string' },
              slots: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async (request) => {
      return handleGetClinicAvailableSlotsRequest(deps, {
        authorizationHeader: request.headers.authorization,
        requestedOrganizationId: request.params.organizationId,
        externalConsultantId: request.params.consultantId,
        date: request.query.date,
      });
    },
  );
}
