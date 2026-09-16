import crypto from 'node:crypto';

import type { TrustedOrganizationContext } from '@samvardiq/identity-access';
import {
  ClinicCmsOperationsConnector,
  ConnectionNotFoundError,
  type Appointment,
  type AppointmentCancellation,
  type AvailableSlots,
  type ClinicCmsConnection,
  type ClinicCmsConnectionRepository,
  type ClinicOperationsConnector,
  type ConnectorAuditRepository,
  type ConnectorHealth,
  type ConnectorSecretProvider,
  type ConsultantSummary,
  type CreateAppointmentInput,
  type CreateEnquiryInput,
  type EnquiryReference,
  type FindPatientsInput,
  type IdempotentOperation,
  type PatientMatch,
  type RegisterPatientInput,
  type RegisteredPatient,
  type RescheduleAppointmentInput,
} from '@samvardiq/clinic-cms-connector';

import { authenticateRequest, type IncomingRequest, type RequestBoundaryDependencies } from './requestBoundary.js';

/**
 * CLINIC-W1B-2 — orchestrates the full authority path (section 1):
 * authenticated principal -> TrustedOrganizationContext (existing,
 * unmodified authenticateRequest) -> this file resolves the requesting
 * organization's OWN clinic connection -> resolves its secret -> builds a
 * connector bound to THAT organization's config -> calls the requested
 * operation. This file is the only place `context.organizationId` is used
 * to look up a `ClinicCmsConnection` — the connector package itself has no
 * concept of organizations at all (section 10), and no route/handler
 * upstream of `authenticateRequest` ever sees a connection or secret.
 */
export interface ClinicOperationsDependencies extends RequestBoundaryDependencies {
  clinicConnections: ClinicCmsConnectionRepository;
  clinicSecrets: ConnectorSecretProvider;
  clinicConnectorAudit?: ConnectorAuditRepository;
  /** Test seam only — production wiring never overrides this (defaults to the real HTTP connector). */
  createClinicConnector?: (config: { baseUrl: string; keyId: string; secret: string }) => ClinicOperationsConnector;
}

function safeErrorCategory(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

async function resolveConnector(
  deps: ClinicOperationsDependencies,
  organizationId: string,
): Promise<{ connector: ClinicOperationsConnector; connection: ClinicCmsConnection }> {
  const connection = await deps.clinicConnections.getEnabledForOrganization(organizationId);
  if (!connection) throw new ConnectionNotFoundError();
  const secret = await deps.clinicSecrets.getSecret(connection.secretReference);
  const factory = deps.createClinicConnector ?? ((config: { baseUrl: string; keyId: string; secret: string }) => new ClinicCmsOperationsConnector(config));
  const connector = factory({ baseUrl: connection.baseUrl, keyId: connection.keyId, secret });
  return { connector, connection };
}

/**
 * Every call is wrapped once here so evidence recording (section 22) is
 * never duplicated per-operation and can never be forgotten in a new
 * handler. Evidence recording failures are swallowed (never turn a
 * successful/failed operation into a different outcome for the caller) —
 * same discipline the Clinic CMS's own `recordAudit` already uses.
 */
async function runClinicOperation<T>(
  deps: ClinicOperationsDependencies,
  context: TrustedOrganizationContext,
  operation: string,
  fn: (connector: ClinicOperationsConnector) => Promise<T>,
  describeResource?: (result: T) => { type: string; id: string } | undefined,
): Promise<T> {
  const correlationId = crypto.randomUUID();
  let connectionId = 'unknown';
  try {
    const resolved = await resolveConnector(deps, context.organizationId);
    connectionId = resolved.connection.connectionId;
    const result = await fn(resolved.connector);
    const resource = describeResource?.(result);
    await recordEvidence(deps, context, connectionId, operation, correlationId, 'SUCCESS', resource?.type, resource?.id);
    return result;
  } catch (error) {
    await recordEvidence(deps, context, connectionId, operation, correlationId, 'ERROR', undefined, undefined, safeErrorCategory(error));
    throw error;
  }
}

/**
 * CLINIC-W2B / ADR-IDENTITY-002 follow-up: every evidence record now
 * carries WHICH principal — human or service — triggered it, sourced only
 * from the already-resolved `context` (never patient-supplied, never free
 * text). Additive: `actorIdentityId`/`actorPrincipalType` are optional on
 * `ConnectorExecutionEvidence`, so this is the only call site that needed
 * to change.
 */
async function recordEvidence(
  deps: ClinicOperationsDependencies,
  context: TrustedOrganizationContext,
  connectionId: string,
  operation: string,
  correlationId: string,
  outcome: 'SUCCESS' | 'DENIED' | 'ERROR',
  externalResourceType?: string,
  externalResourceId?: string,
  safeErrorCategory?: string,
): Promise<void> {
  if (!deps.clinicConnectorAudit) return;
  try {
    await deps.clinicConnectorAudit.record({
      evidenceId: crypto.randomUUID(),
      organizationId: context.organizationId,
      connectionId,
      connectorType: 'clinic-cms',
      operation,
      correlationId,
      externalResourceType,
      externalResourceId,
      outcome,
      retryCount: 0,
      safeErrorCategory,
      actorIdentityId: context.identityId,
      actorPrincipalType: context.principalType,
      occurredAt: new Date().toISOString(),
    });
  } catch {
    // Section 22/26: an evidence-recording failure must never turn a
    // successful clinic operation into a client-visible error, and must
    // never itself leak anything — swallowed, matching the CMS's own
    // recordAudit discipline.
  }
}

/**
 * CLINIC-W2B / ADR-IDENTITY-002 — context-accepting entry points, added
 * alongside (never replacing) the request-accepting handlers below. These
 * exist for exactly one reason: a WhatsApp-originated (or any future
 * non-human-channel-originated) caller has no bearer token for
 * `authenticateRequest` to verify — its `TrustedOrganizationContext` is
 * instead produced by `resolveChannelServiceContext` (the new
 * communication package) calling the SAME, unmodified
 * `AuthorizationService.resolveTrustedContext()` this file's own
 * `authenticateRequest`-based handlers already rely on. This file remains
 * unaware of *how* a context was produced — human session or verified
 * channel event — exactly as `GoalReadService`'s own "the real boundary is
 * procedural, not a runtime brand" precedent already establishes elsewhere
 * in this codebase. Every `handle*Request` function below is now a thin
 * wrapper: `authenticateRequest` then delegate — behavior is byte-for-byte
 * unchanged from before this refactor (proven by every pre-existing test
 * in this file's own test suite passing unmodified).
 */
export async function listClinicConsultantsForContext(deps: ClinicOperationsDependencies, context: TrustedOrganizationContext): Promise<ConsultantSummary[]> {
  return runClinicOperation(deps, context, 'listConsultants', (connector) => connector.listConsultants());
}

export async function getClinicAvailableSlotsForContext(
  deps: ClinicOperationsDependencies,
  context: TrustedOrganizationContext,
  input: { externalConsultantId: string; date: string },
): Promise<AvailableSlots> {
  return runClinicOperation(deps, context, 'getAvailableSlots', (connector) => connector.getAvailableSlots(input));
}

export async function findClinicPatientsForContext(deps: ClinicOperationsDependencies, context: TrustedOrganizationContext, input: FindPatientsInput): Promise<PatientMatch[]> {
  return runClinicOperation(deps, context, 'findPatients', (connector) => connector.findPatients(input));
}

export async function registerClinicPatientForContext(
  deps: ClinicOperationsDependencies,
  context: TrustedOrganizationContext,
  input: RegisterPatientInput & IdempotentOperation,
): Promise<RegisteredPatient> {
  return runClinicOperation(deps, context, 'registerPatient', (connector) => connector.registerPatient(input), (r) => ({ type: 'patient', id: r.externalPatientId }));
}

export async function createClinicEnquiryForContext(
  deps: ClinicOperationsDependencies,
  context: TrustedOrganizationContext,
  input: CreateEnquiryInput & IdempotentOperation,
): Promise<EnquiryReference> {
  return runClinicOperation(deps, context, 'createEnquiry', (connector) => connector.createEnquiry(input), (r) => ({ type: 'enquiry', id: r.externalEnquiryId }));
}

export async function createClinicAppointmentForContext(
  deps: ClinicOperationsDependencies,
  context: TrustedOrganizationContext,
  input: CreateAppointmentInput & IdempotentOperation,
): Promise<Appointment> {
  return runClinicOperation(deps, context, 'createAppointment', (connector) => connector.createAppointment(input), (r) => ({ type: 'appointment', id: r.externalAppointmentId }));
}

export type ClinicConsultantsRequest = IncomingRequest;

export async function handleListClinicConsultantsRequest(deps: ClinicOperationsDependencies, request: ClinicConsultantsRequest): Promise<ConsultantSummary[]> {
  const context = await authenticateRequest(deps, request);
  return listClinicConsultantsForContext(deps, context);
}

export interface ClinicAvailableSlotsRequest extends IncomingRequest {
  externalConsultantId: string;
  date: string;
}

export async function handleGetClinicAvailableSlotsRequest(deps: ClinicOperationsDependencies, request: ClinicAvailableSlotsRequest): Promise<AvailableSlots> {
  const context = await authenticateRequest(deps, request);
  return getClinicAvailableSlotsForContext(deps, context, { externalConsultantId: request.externalConsultantId, date: request.date });
}

export interface ClinicFindPatientsRequest extends IncomingRequest, FindPatientsInput {}

export async function handleFindClinicPatientsRequest(deps: ClinicOperationsDependencies, request: ClinicFindPatientsRequest): Promise<PatientMatch[]> {
  const context = await authenticateRequest(deps, request);
  return findClinicPatientsForContext(deps, context, { query: request.query });
}

export interface ClinicRegisterPatientRequest extends IncomingRequest, RegisterPatientInput, IdempotentOperation {}

export async function handleRegisterClinicPatientRequest(deps: ClinicOperationsDependencies, request: ClinicRegisterPatientRequest): Promise<RegisteredPatient> {
  const context = await authenticateRequest(deps, request);
  return registerClinicPatientForContext(deps, context, {
    firstName: request.firstName,
    lastName: request.lastName,
    age: request.age,
    gender: request.gender,
    contactNumber: request.contactNumber,
    email: request.email,
    address: request.address,
    enquiry: request.enquiry,
    idempotencyKey: request.idempotencyKey,
  });
}

export interface ClinicCreateEnquiryRequest extends IncomingRequest, CreateEnquiryInput, IdempotentOperation {}

export async function handleCreateClinicEnquiryRequest(deps: ClinicOperationsDependencies, request: ClinicCreateEnquiryRequest): Promise<EnquiryReference> {
  const context = await authenticateRequest(deps, request);
  return createClinicEnquiryForContext(deps, context, {
    externalPatientId: request.externalPatientId,
    channel: request.channel,
    sourceDetail: request.sourceDetail,
    preferredLanguage: request.preferredLanguage,
    idempotencyKey: request.idempotencyKey,
  });
}

export interface ClinicCreateAppointmentRequest extends IncomingRequest, CreateAppointmentInput, IdempotentOperation {}

export async function handleCreateClinicAppointmentRequest(deps: ClinicOperationsDependencies, request: ClinicCreateAppointmentRequest): Promise<Appointment> {
  const context = await authenticateRequest(deps, request);
  return createClinicAppointmentForContext(deps, context, {
    externalPatientId: request.externalPatientId,
    externalConsultantId: request.externalConsultantId,
    appointmentDate: request.appointmentDate,
    appointmentTime: request.appointmentTime,
    duration: request.duration,
    notes: request.notes,
    externalEnquiryId: request.externalEnquiryId,
    idempotencyKey: request.idempotencyKey,
  });
}

export interface ClinicGetAppointmentRequest extends IncomingRequest {
  externalAppointmentId: string;
}

export async function handleGetClinicAppointmentRequest(deps: ClinicOperationsDependencies, request: ClinicGetAppointmentRequest): Promise<Appointment> {
  const context = await authenticateRequest(deps, request);
  return runClinicOperation(deps, context, 'getAppointment', (connector) => connector.getAppointment(request.externalAppointmentId));
}

export interface ClinicRescheduleAppointmentRequest extends IncomingRequest, RescheduleAppointmentInput {
  externalAppointmentId: string;
}

export async function handleRescheduleClinicAppointmentRequest(deps: ClinicOperationsDependencies, request: ClinicRescheduleAppointmentRequest): Promise<Appointment> {
  const context = await authenticateRequest(deps, request);
  return runClinicOperation(
    deps,
    context,
    'rescheduleAppointment',
    (connector) => connector.rescheduleAppointment(request.externalAppointmentId, { appointmentDate: request.appointmentDate, appointmentTime: request.appointmentTime }),
    (r) => ({ type: 'appointment', id: r.externalAppointmentId }),
  );
}

export interface ClinicCancelAppointmentRequest extends IncomingRequest {
  externalAppointmentId: string;
}

export async function handleCancelClinicAppointmentRequest(deps: ClinicOperationsDependencies, request: ClinicCancelAppointmentRequest): Promise<AppointmentCancellation> {
  const context = await authenticateRequest(deps, request);
  return runClinicOperation(deps, context, 'cancelAppointment', (connector) => connector.cancelAppointment(request.externalAppointmentId), (r) => ({
    type: 'appointment',
    id: r.externalAppointmentId,
  }));
}

export async function handleClinicHealthCheckRequest(deps: ClinicOperationsDependencies, request: IncomingRequest): Promise<ConnectorHealth> {
  const context = await authenticateRequest(deps, request);
  return runClinicOperation(deps, context, 'checkHealth', (connector) => connector.checkHealth());
}
