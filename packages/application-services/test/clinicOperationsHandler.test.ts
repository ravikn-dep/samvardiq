import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EnvConnectorSecretProvider,
  InMemoryClinicCmsConnectionRepository,
  InMemoryConnectorAuditRepository,
  type Appointment,
  type AppointmentCancellation,
  type AvailableSlots,
  type ClinicOperationsConnector,
  type ConnectorHealth,
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

import * as clinicHandlers from '../src/clinicOperationsHandler.js';
import { classifyClinicOperationsError } from '../src/clinicErrors.js';
import { buildWorld, provisionMember, type TestWorld } from './setup.js';

/** A configurable, non-network fake — the handler layer under test is the orchestration (auth -> connection lookup -> secret -> connector call -> evidence), never the HTTP/HMAC wire protocol (already proven in clinic-cms-connector's own suite). */
class FakeClinicOperationsConnector implements ClinicOperationsConnector {
  calls: string[] = [];
  throwOn: string | null = null;
  throwError: Error = new Error('fake failure');

  private guard(name: string): void {
    this.calls.push(name);
    if (this.throwOn === name) throw this.throwError;
  }

  async checkHealth(): Promise<ConnectorHealth> {
    this.guard('checkHealth');
    return { status: 'ok' };
  }
  async listConsultants(): Promise<ConsultantSummary[]> {
    this.guard('listConsultants');
    return [{ externalConsultantId: '7', displayName: 'Dr. Test' }];
  }
  async getAvailableSlots(): Promise<AvailableSlots> {
    this.guard('getAvailableSlots');
    return { externalConsultantId: '7', date: '2026-08-13', timezone: 'Asia/Kolkata', slots: ['09:00'] };
  }
  async findPatients(_input: FindPatientsInput): Promise<PatientMatch[]> {
    this.guard('findPatients');
    return [{ externalPatientId: 'P1', displayName: 'A B', contactHint: '+91••••••1234', age: 30 }];
  }
  async registerPatient(_input: RegisterPatientInput & IdempotentOperation): Promise<RegisteredPatient> {
    this.guard('registerPatient');
    return { externalPatientId: 'P1', displayName: 'A B', contactHint: '+91••••••1234' };
  }
  async createEnquiry(_input: CreateEnquiryInput & IdempotentOperation): Promise<EnquiryReference> {
    this.guard('createEnquiry');
    return { externalEnquiryId: 'ENQ-1', externalPatientId: 'P1' };
  }
  async createAppointment(_input: CreateAppointmentInput & IdempotentOperation): Promise<Appointment> {
    this.guard('createAppointment');
    return this.appointment();
  }
  async getAppointment(): Promise<Appointment> {
    this.guard('getAppointment');
    return this.appointment();
  }
  async rescheduleAppointment(_id: string, _input: RescheduleAppointmentInput): Promise<Appointment> {
    this.guard('rescheduleAppointment');
    return { ...this.appointment(), status: 'Rescheduled' };
  }
  async cancelAppointment(): Promise<AppointmentCancellation> {
    this.guard('cancelAppointment');
    return { externalAppointmentId: 'APT-1', status: 'Cancelled' };
  }
  private appointment(): Appointment {
    return { externalAppointmentId: 'APT-1', externalPatientId: 'P1', externalConsultantId: '7', appointmentDate: '2026-08-13', appointmentTime: '10:00', duration: 30, status: 'Scheduled', checkedInAt: null };
  }
}

async function buildClinicWorld() {
  const world = await buildWorld();
  const clinicConnections = new InMemoryClinicCmsConnectionRepository();
  const clinicSecrets = new EnvConnectorSecretProvider({ CLINIC_ORG_A_SECRET: 'a-real-secret-value-at-least-32-chars' });
  const clinicConnectorAudit = new InMemoryConnectorAuditRepository();
  const fakeConnector = new FakeClinicOperationsConnector();
  const deps: clinicHandlers.ClinicOperationsDependencies = {
    ...world.deps,
    clinicConnections,
    clinicSecrets,
    clinicConnectorAudit,
    createClinicConnector: () => fakeConnector,
  };
  return { world, deps, clinicConnections, clinicConnectorAudit, fakeConnector };
}

async function requestFor(world: TestWorld, organizationId: string, subject: string) {
  const token = await world.issuer.signToken({ sub: subject });
  return { authorizationHeader: `Bearer ${token}`, requestedOrganizationId: organizationId };
}

test('B/C: unauthenticated / invalid token is denied before any connection lookup ever happens', async () => {
  const { deps, fakeConnector } = await buildClinicWorld();
  await assert.rejects(clinicHandlers.handleListClinicConsultantsRequest(deps, { authorizationHeader: undefined, requestedOrganizationId: 'org-A' }));
  assert.deepEqual(fakeConnector.calls, []);
});

test('K: no clinic connection configured for the organization fails closed with UPSTREAM_UNAVAILABLE, never 500', async () => {
  const { world, deps } = await buildClinicWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  const request = await requestFor(world, 'org-A', 'sub-1');

  await assert.rejects(clinicHandlers.handleListClinicConsultantsRequest(deps, request), (error: unknown) => {
    assert.equal(classifyClinicOperationsError(error).errorClass, 'UPSTREAM_UNAVAILABLE');
    return true;
  });
});

test('J: a disabled connection is treated identically to a missing one', async () => {
  const { world, deps, clinicConnections } = await buildClinicWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await clinicConnections.create({
    connectionId: 'conn-1',
    organizationId: 'org-A',
    baseUrl: 'https://clinic.example.com',
    keyId: 'key-1',
    secretReference: 'env:CLINIC_ORG_A_SECRET',
    approvedScopes: ['health:read'],
    timezone: 'Asia/Kolkata',
    enabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const request = await requestFor(world, 'org-A', 'sub-1');
  await assert.rejects(clinicHandlers.handleListClinicConsultantsRequest(deps, request), (error: unknown) => {
    assert.equal(classifyClinicOperationsError(error).errorClass, 'UPSTREAM_UNAVAILABLE');
    return true;
  });
});

test('L: a connection referencing an unconfigured secret fails closed', async () => {
  const { world, deps, clinicConnections } = await buildClinicWorld();
  await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await clinicConnections.create({
    connectionId: 'conn-1',
    organizationId: 'org-A',
    baseUrl: 'https://clinic.example.com',
    keyId: 'key-1',
    secretReference: 'env:MISSING_SECRET',
    approvedScopes: ['health:read'],
    timezone: 'Asia/Kolkata',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const request = await requestFor(world, 'org-A', 'sub-1');
  await assert.rejects(clinicHandlers.handleListClinicConsultantsRequest(deps, request), (error: unknown) => {
    assert.equal(classifyClinicOperationsError(error).errorClass, 'UPSTREAM_UNAVAILABLE');
    return true;
  });
});

async function withConfiguredConnection(): Promise<Awaited<ReturnType<typeof buildClinicWorld>> & { request: { authorizationHeader: string; requestedOrganizationId: string } }> {
  const built = await buildClinicWorld();
  await provisionMember(built.world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
  await built.clinicConnections.create({
    connectionId: 'conn-1',
    organizationId: 'org-A',
    baseUrl: 'https://clinic.example.com',
    keyId: 'key-1',
    secretReference: 'env:CLINIC_ORG_A_SECRET',
    approvedScopes: ['health:read', 'patients:read', 'patients:write', 'consultants:read', 'appointments:read', 'appointments:write', 'enquiries:write'],
    timezone: 'Asia/Kolkata',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const request = await requestFor(built.world, 'org-A', 'sub-1');
  return { ...built, request };
}

test('AL: the full authority chain works end to end for the read slice, and evidence is recorded as SUCCESS with no secret', async () => {
  const { deps, request, clinicConnectorAudit } = await withConfiguredConnection();
  const consultants = await clinicHandlers.handleListClinicConsultantsRequest(deps, request);
  assert.deepEqual(consultants, [{ externalConsultantId: '7', displayName: 'Dr. Test' }]);

  assert.equal(clinicConnectorAudit.records.length, 1);
  const record = clinicConnectorAudit.records[0]!;
  assert.equal(record.outcome, 'SUCCESS');
  assert.equal(record.organizationId, 'org-A');
  assert.equal(record.connectionId, 'conn-1');
  assert.deepEqual(Object.keys(record).sort(), ['connectionId', 'connectorType', 'correlationId', 'evidenceId', 'externalResourceId', 'externalResourceType', 'occurredAt', 'operation', 'organizationId', 'outcome', 'retryCount', 'safeErrorCategory'].sort());
});

test('a connector-level failure is recorded as ERROR evidence with only a safe error category, never the raw error/secret', async () => {
  const { deps, request, fakeConnector, clinicConnectorAudit } = await withConfiguredConnection();
  fakeConnector.throwOn = 'listConsultants';
  fakeConnector.throwError = new Error('super-secret-hmac-value-should-never-appear');

  await assert.rejects(clinicHandlers.handleListClinicConsultantsRequest(deps, request));
  assert.equal(clinicConnectorAudit.records.length, 1);
  const record = clinicConnectorAudit.records[0]!;
  assert.equal(record.outcome, 'ERROR');
  assert.equal(record.safeErrorCategory, 'Error');
  assert.equal(JSON.stringify(record).includes('super-secret-hmac-value-should-never-appear'), false);
});

test('AM: getAvailableSlots plumbs consultantId/date through to the connector unchanged', async () => {
  const { deps, request } = await withConfiguredConnection();
  const result = await clinicHandlers.handleGetClinicAvailableSlotsRequest(deps, { ...request, externalConsultantId: '7', date: '2026-08-13' });
  assert.deepEqual(result.slots, ['09:00']);
});

test('O: existing-patient enquiry creation plumbs through the handler layer', async () => {
  const { deps, request } = await withConfiguredConnection();
  const result = await clinicHandlers.handleCreateClinicEnquiryRequest(deps, { ...request, externalPatientId: 'P1', channel: 'PHONE', preferredLanguage: 'en-IN', idempotencyKey: 'k1' });
  assert.equal(result.externalEnquiryId, 'ENQ-1');
});

test('full write-capability set: register, create/read/reschedule/cancel appointment all plumb through', async () => {
  const { deps, request } = await withConfiguredConnection();

  const patient = await clinicHandlers.handleRegisterClinicPatientRequest(deps, { ...request, firstName: 'A', lastName: 'B', contactNumber: '9876543210', idempotencyKey: 'k1' });
  assert.equal(patient.externalPatientId, 'P1');

  const created = await clinicHandlers.handleCreateClinicAppointmentRequest(deps, {
    ...request,
    externalPatientId: 'P1',
    externalConsultantId: '7',
    appointmentDate: '2026-08-13',
    appointmentTime: '10:00',
    idempotencyKey: 'k2',
  });
  assert.equal(created.externalAppointmentId, 'APT-1');

  const read = await clinicHandlers.handleGetClinicAppointmentRequest(deps, { ...request, externalAppointmentId: 'APT-1' });
  assert.equal(read.status, 'Scheduled');

  const rescheduled = await clinicHandlers.handleRescheduleClinicAppointmentRequest(deps, { ...request, externalAppointmentId: 'APT-1', appointmentDate: '2026-08-14', appointmentTime: '11:00' });
  assert.equal(rescheduled.status, 'Rescheduled');

  const cancelled = await clinicHandlers.handleCancelClinicAppointmentRequest(deps, { ...request, externalAppointmentId: 'APT-1' });
  assert.equal(cancelled.status, 'Cancelled');
});

test('BA/BB/BC: no handler for completeAppointment/checkIn/markNoShow exists on this module', () => {
  const exported = Object.keys(clinicHandlers);
  for (const name of exported) {
    assert.doesNotMatch(name, /complete/i);
    assert.doesNotMatch(name, /checkIn/i);
    assert.doesNotMatch(name, /noShow/i);
  }
});
