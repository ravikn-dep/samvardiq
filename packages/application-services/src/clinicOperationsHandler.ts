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
    await recordEvidence(deps, context.organizationId, connectionId, operation, correlationId, 'SUCCESS', resource?.type, resource?.id);
    return result;
  } catch (error) {
    await recordEvidence(deps, context.organizationId, connectionId, operation, correlationId, 'ERROR', undefined, undefined, safeErrorCategory(error));
    throw error;
  }
}

async function recordEvidence(
  deps: ClinicOperationsDependencies,
  organizationId: string,
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
      organizationId,
      connectionId,
      connectorType: 'clinic-cms',
      operation,
      correlationId,
      externalResourceType,
      externalResourceId,
      outcome,
      retryCount: 0,
      safeErrorCategory,
      occurredAt: new Date().toISOString(),
    });
  } catch {
    // Section 22/26: an evidence-recording failure must never turn a
    // successful clinic operation into a client-visible error, and must
    // never itself leak anything — swallowed, matching the CMS's own
    // recordAudit discipline.
  }
}

export type ClinicConsultantsRequest = IncomingRequest;

export async function handleListClinicConsultantsRequest(deps: ClinicOperationsDependencies, request: ClinicConsultantsRequest): Promise<ConsultantSummary[]> {
  const context = await authenticateRequest(deps, request);
  return runClinicOperation(deps, context, 'listConsultants', (connector) => connector.listConsultants());
}

export interface ClinicAvailableSlotsRequest extends IncomingRequest {
  externalConsultantId: string;
  date: string;
}

export async function handleGetClinicAvailableSlotsRequest(deps: ClinicOperationsDependencies, request: ClinicAvailableSlotsRequest): Promise<AvailableSlots> {
  const context = await authenticateRequest(deps, request);
  return runClinicOperation(deps, context, 'getAvailableSlots', (connector) =>
    connector.getAvailableSlots({ externalConsultantId: request.externalConsultantId, date: request.date }),
  );
}

export interface ClinicFindPatientsRequest extends IncomingRequest, FindPatientsInput {}

export async function handleFindClinicPatientsRequest(deps: ClinicOperationsDependencies, request: ClinicFindPatientsRequest): Promise<PatientMatch[]> {
  const context = await authenticateRequest(deps, request);
  return runClinicOperation(deps, context, 'findPatients', (connector) => connector.findPatients({ query: request.query }));
}

export interface ClinicRegisterPatientRequest extends IncomingRequest, RegisterPatientInput, IdempotentOperation {}

export async function handleRegisterClinicPatientRequest(deps: ClinicOperationsDependencies, request: ClinicRegisterPatientRequest): Promise<RegisteredPatient> {
  const context = await authenticateRequest(deps, request);
  const input: RegisterPatientInput & IdempotentOperation = {
    firstName: request.firstName,
    lastName: request.lastName,
    age: request.age,
    gender: request.gender,
    contactNumber: request.contactNumber,
    email: request.email,
    address: request.address,
    enquiry: request.enquiry,
    idempotencyKey: request.idempotencyKey,
  };
  return runClinicOperation(deps, context, 'registerPatient', (connector) => connector.registerPatient(input), (r) => ({ type: 'patient', id: r.externalPatientId }));
}

export interface ClinicCreateEnquiryRequest extends IncomingRequest, CreateEnquiryInput, IdempotentOperation {}

export async function handleCreateClinicEnquiryRequest(deps: ClinicOperationsDependencies, request: ClinicCreateEnquiryRequest): Promise<EnquiryReference> {
  const context = await authenticateRequest(deps, request);
  const input: CreateEnquiryInput & IdempotentOperation = {
    externalPatientId: request.externalPatientId,
    channel: request.channel,
    sourceDetail: request.sourceDetail,
    preferredLanguage: request.preferredLanguage,
    idempotencyKey: request.idempotencyKey,
  };
  return runClinicOperation(deps, context, 'createEnquiry', (connector) => connector.createEnquiry(input), (r) => ({ type: 'enquiry', id: r.externalEnquiryId }));
}

export interface ClinicCreateAppointmentRequest extends IncomingRequest, CreateAppointmentInput, IdempotentOperation {}

export async function handleCreateClinicAppointmentRequest(deps: ClinicOperationsDependencies, request: ClinicCreateAppointmentRequest): Promise<Appointment> {
  const context = await authenticateRequest(deps, request);
  const input: CreateAppointmentInput & IdempotentOperation = {
    externalPatientId: request.externalPatientId,
    externalConsultantId: request.externalConsultantId,
    appointmentDate: request.appointmentDate,
    appointmentTime: request.appointmentTime,
    duration: request.duration,
    notes: request.notes,
    externalEnquiryId: request.externalEnquiryId,
    idempotencyKey: request.idempotencyKey,
  };
  return runClinicOperation(deps, context, 'createAppointment', (connector) => connector.createAppointment(input), (r) => ({ type: 'appointment', id: r.externalAppointmentId }));
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
