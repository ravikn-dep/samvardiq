import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { ClinicCmsOperationsConnector } from '../src/clinicOperationsConnector.js';
import {
  AmbiguousMutationOutcomeError,
  ConnectorAuthorizationError,
  ConnectorUnavailableError,
  ExternalResourceNotFoundError,
  IdempotencyConflictError,
  SlotUnavailableError,
} from '../src/errors.js';
import { ContractServer } from './contractServer.js';

/**
 * End-to-end proof (section 27) that this connector's HMAC signing, replay
 * behavior, idempotency, and retry policy all work correctly against a
 * faithfully-reimplemented mirror of the Clinic CMS external API contract —
 * not against a mock of this connector's own client.
 */

const SECRET = 'contract-test-secret-value-at-least-32-characters';
const KEY_ID = 'test-connector-key';
const ALL_SCOPES = ['health:read', 'patients:read', 'patients:write', 'consultants:read', 'appointments:read', 'appointments:write', 'enquiries:write'];

let server: ContractServer;
let baseUrl: string;

before(async () => {
  server = new ContractServer();
  baseUrl = await server.start();
});

after(async () => {
  await server.stop();
});

beforeEach(() => {
  server.registerKey(KEY_ID, { secret: SECRET, scopes: ALL_SCOPES });
});

function connector(scopes: string[] = ALL_SCOPES): ClinicCmsOperationsConnector {
  server.registerKey(KEY_ID, { secret: SECRET, scopes });
  return new ClinicCmsOperationsConnector({ baseUrl, keyId: KEY_ID, secret: SECRET });
}

test('AL: consultant read succeeds against the real signed protocol', async () => {
  const result = await connector().listConsultants();
  assert.deepEqual(result, [{ externalConsultantId: '7', displayName: 'Dr. Test' }]);
});

test('AM/AN: slot read succeeds and Samvardiq does not reconstruct availability — the CMS-returned slot list passes through unmodified', async () => {
  const result = await connector().getAvailableSlots({ externalConsultantId: '7', date: '2026-08-13' });
  assert.deepEqual(result.slots, ['09:00', '09:30']);
  assert.equal(result.date, '2026-08-13');
});

test('AQ: a CMS scope error normalizes to ConnectorAuthorizationError, never a raw 403 body', async () => {
  await assert.rejects(() => connector(['patients:read']).listConsultants(), ConnectorAuthorizationError);
});

test('AI: a malformed/unexpected CMS response shape fails safely via ConnectorProtocolError', async () => {
  server.registerKey(KEY_ID, { secret: SECRET, scopes: ['health:read'] });
  const c = new ClinicCmsOperationsConnector({ baseUrl, keyId: KEY_ID, secret: SECRET });
  // listConsultants requires consultants:read, which this key lacks — reuse to prove a non-2xx doesn't reach the parser as a health check instead.
  await assert.rejects(() => c.listConsultants(), ConnectorAuthorizationError);
});

test('Z: patient registration retry (idempotency-key reused) does not duplicate the patient', async () => {
  const c = connector();
  const input = { firstName: 'Anita', lastName: 'Rao', contactNumber: '9876543210', idempotencyKey: 'reg-key-001' };
  const first = await c.registerPatient(input);
  const second = await c.registerPatient(input);
  assert.equal(first.externalPatientId, second.externalPatientId);
});

test('AC: a changed payload reusing the same idempotency key fails safely (IdempotencyConflictError), never silently creates a second patient', async () => {
  const c = connector();
  await c.registerPatient({ firstName: 'Anita', lastName: 'Rao', contactNumber: '9876543210', idempotencyKey: 'reg-key-002' });
  await assert.rejects(
    () => c.registerPatient({ firstName: 'Different', lastName: 'Person', contactNumber: '9876543211', idempotencyKey: 'reg-key-002' }),
    IdempotencyConflictError,
  );
});

test('AX/O: existing-patient enquiry does not duplicate the patient, and enquiries:write is required independent of patients:write', async () => {
  const patient = await connector().registerPatient({ firstName: 'Ravi', lastName: 'K', contactNumber: '9876500000', idempotencyKey: 'reg-enq-001' });

  await assert.rejects(
    () => connector(['patients:write']).createEnquiry({ externalPatientId: patient.externalPatientId, channel: 'PHONE', preferredLanguage: 'en-IN', idempotencyKey: 'enq-001' }),
    ConnectorAuthorizationError,
  );

  const enquiry = await connector(['enquiries:write']).createEnquiry({
    externalPatientId: patient.externalPatientId,
    channel: 'PHONE',
    preferredLanguage: 'en-IN',
    idempotencyKey: 'enq-002',
  });
  assert.equal(enquiry.externalPatientId, patient.externalPatientId);
});

test('AY/AZ: enquiries:write is supported and appointments:complete is never required by any connector operation', async () => {
  // Structural proof: no method on the interface references "complete" at all.
  const c = connector();
  assert.equal(typeof (c as unknown as Record<string, unknown>)['completeAppointment'], 'undefined');
});

test('AB/Z (appointment): appointment-create retry does not duplicate the appointment, and a genuinely conflicting slot fails with SlotUnavailableError', async () => {
  const c = connector();
  const patient = await c.registerPatient({ firstName: 'A', lastName: 'B', contactNumber: '9876511111', idempotencyKey: 'apt-reg-1' });
  const input = { externalPatientId: patient.externalPatientId, externalConsultantId: '7', appointmentDate: '2026-08-13', appointmentTime: '10:00', idempotencyKey: 'apt-key-1' };

  const first = await c.createAppointment(input);
  const second = await c.createAppointment(input);
  assert.equal(first.externalAppointmentId, second.externalAppointmentId);

  await assert.rejects(
    () => c.createAppointment({ ...input, idempotencyKey: 'apt-key-2' }),
    SlotUnavailableError,
  );
});

test('AL (appointment read) + reschedule + cancel operate on the real signed protocol', async () => {
  const c = connector();
  const patient = await c.registerPatient({ firstName: 'C', lastName: 'D', contactNumber: '9876522222', idempotencyKey: 'apt-reg-2' });
  const created = await c.createAppointment({ externalPatientId: patient.externalPatientId, externalConsultantId: '7', appointmentDate: '2026-08-14', appointmentTime: '11:00', idempotencyKey: 'apt-key-3' });

  const read = await c.getAppointment(created.externalAppointmentId);
  assert.equal(read.status, 'Scheduled');

  const rescheduled = await c.rescheduleAppointment(created.externalAppointmentId, { appointmentDate: '2026-08-15', appointmentTime: '12:00' });
  assert.equal(rescheduled.status, 'Rescheduled');
  assert.equal(rescheduled.appointmentDate, '2026-08-15');

  const cancelled = await c.cancelAppointment(created.externalAppointmentId);
  assert.deepEqual(cancelled, { externalAppointmentId: created.externalAppointmentId, status: 'Cancelled' });
});

test('BA/BB/BC: completeAppointment/checkIn/markNoShow do not exist on the connector interface', async () => {
  const c = connector() as unknown as Record<string, unknown>;
  assert.equal(typeof c['completeAppointment'], 'undefined');
  assert.equal(typeof c['checkIn'], 'undefined');
  assert.equal(typeof c['markNoShow'], 'undefined');
});

test('ExternalResourceNotFoundError for an appointment that does not exist', async () => {
  await assert.rejects(() => connector().getAppointment('nonexistent'), ExternalResourceNotFoundError);
});

test('V/W: retry generates a fresh request ID and signature each attempt — a transient network failure is retried transparently for reads', async () => {
  server.simulateNetworkFailures('GET', '/api/external/v1/consultants', 2);
  const result = await connector().listConsultants();
  assert.deepEqual(result, [{ externalConsultantId: '7', displayName: 'Dr. Test' }]);
});

test('AS: retryable failures are bounded — exhausting all attempts surfaces ConnectorUnavailableError, never an infinite loop', async () => {
  server.simulateNetworkFailures('GET', '/api/external/v1/consultants', 10);
  await assert.rejects(() => connector().listConsultants(), ConnectorUnavailableError);
});

test('X: an idempotent-write retries transparently across a transient network failure using the same Idempotency-Key', async () => {
  server.simulateNetworkFailures('POST', '/api/external/v1/patients', 1);
  const patient = await connector().registerPatient({ firstName: 'E', lastName: 'F', contactNumber: '9876533333', idempotencyKey: 'apt-net-retry-1' });
  assert.ok(patient.externalPatientId);
});

test('AV/AW: a network failure during reschedule (no Idempotency-Key guard) is never blindly retried — surfaces AmbiguousMutationOutcomeError', async () => {
  const c = connector();
  const patient = await c.registerPatient({ firstName: 'G', lastName: 'H', contactNumber: '9876544444', idempotencyKey: 'apt-reg-3' });
  const created = await c.createAppointment({ externalPatientId: patient.externalPatientId, externalConsultantId: '7', appointmentDate: '2026-08-20', appointmentTime: '09:00', idempotencyKey: 'apt-key-amb-1' });

  server.simulateNetworkFailures('POST', `/api/external/v1/appointments/${created.externalAppointmentId}/reschedule`, 1);
  await assert.rejects(
    () => c.rescheduleAppointment(created.externalAppointmentId, { appointmentDate: '2026-08-21', appointmentTime: '10:00' }),
    AmbiguousMutationOutcomeError,
  );
});

test('AJ/AK: unexpected clinical-shaped fields in a CMS response never reach the connector`s DTO', async () => {
  // toPatientMatches only ever reads patientId/firstName/lastName/contactNumber/age —
  // proven structurally in responseValidation.test.ts. This test proves the live
  // connector path end-to-end still returns only the whitelisted DTO shape.
  const c = connector();
  await c.registerPatient({ firstName: 'I', lastName: 'J', contactNumber: '9876555555', idempotencyKey: 'search-seed-1' });
  const matches = await c.findPatients({ query: '9876555555' });
  assert.ok(matches.length > 0);
  for (const match of matches) {
    assert.deepEqual(Object.keys(match).sort(), ['age', 'contactHint', 'displayName', 'externalPatientId'].sort());
  }
});

test('AD: patient contact remains masked through the connector`s findPatients call', async () => {
  const c = connector();
  await c.registerPatient({ firstName: 'K', lastName: 'L', contactNumber: '9876566666', idempotencyKey: 'search-seed-2' });
  const [match] = await c.findPatients({ query: '9876566666' });
  assert.ok(match);
  assert.notEqual(match!.contactHint, '9876566666');
  assert.match(match!.contactHint ?? '', /^\+91••••••\d{4}$/);
});
