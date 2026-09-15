import { ConnectorProtocolError } from './errors.js';
import type { Appointment, AppointmentCancellation, AppointmentStatus, AvailableSlots, ConsultantSummary, EnquiryReference, PatientMatch, RegisteredPatient } from './types.js';

/**
 * Whitelist-only response projection (section 19). Every function here
 * reads ONLY the specific fields it names from the raw remote object and
 * constructs a brand-new object from them — it never spreads `...raw` and
 * never returns a reference to any part of the input. This is what makes
 * it structurally impossible for an unexpected remote field (a clinical
 * field, a stray internal ID, anything not named below) to reach a caller,
 * regardless of what the Clinic CMS response actually contains.
 *
 * Every function throws `ConnectorProtocolError` — never lets a malformed
 * shape propagate as `undefined`/`null` fields a caller might not check.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new ConnectorProtocolError(`expected string field "${key}"`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ConnectorProtocolError(`expected optional string field "${key}"`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') throw new ConnectorProtocolError(`expected number field "${key}"`);
  return value;
}

const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ['Scheduled', 'Rescheduled', 'Cancelled', 'Completed', 'No-show'];

export function toConnectorHealth(raw: unknown): { status: 'ok' } {
  if (!isRecord(raw) || raw.status !== 'ok') throw new ConnectorProtocolError('unexpected health response shape');
  return { status: 'ok' };
}

export function toConsultantSummary(raw: unknown): ConsultantSummary {
  if (!isRecord(raw)) throw new ConnectorProtocolError('unexpected consultant response shape');
  const id = raw.id;
  if (typeof id !== 'number' && typeof id !== 'string') throw new ConnectorProtocolError('expected consultant id');
  return { externalConsultantId: String(id), displayName: requireString(raw, 'name') };
}

export function toConsultantList(raw: unknown): ConsultantSummary[] {
  if (!isRecord(raw) || !Array.isArray(raw.consultants)) throw new ConnectorProtocolError('unexpected consultants list response shape');
  return raw.consultants.map(toConsultantSummary);
}

export function toAvailableSlots(raw: unknown): AvailableSlots {
  if (!isRecord(raw) || !Array.isArray(raw.slots) || !raw.slots.every((slot) => typeof slot === 'string')) {
    throw new ConnectorProtocolError('unexpected availability response shape');
  }
  const consultantId = raw.consultantId;
  if (typeof consultantId !== 'number' && typeof consultantId !== 'string') throw new ConnectorProtocolError('expected consultantId in availability response');
  return {
    externalConsultantId: String(consultantId),
    date: requireString(raw, 'date'),
    timezone: requireString(raw, 'timezone'),
    slots: raw.slots as string[],
  };
}

function toPatientMatchFromRecord(record: Record<string, unknown>): PatientMatch {
  const age = record.age;
  if (age !== undefined && age !== null && typeof age !== 'number') throw new ConnectorProtocolError('expected numeric or absent age');
  return {
    externalPatientId: requireString(record, 'patientId'),
    displayName: `${requireString(record, 'firstName')} ${requireString(record, 'lastName')}`.trim(),
    contactHint: optionalString(record, 'contactNumber'),
    age: (age as number | undefined) ?? null,
  };
}

export function toPatientMatches(raw: unknown): PatientMatch[] {
  if (!isRecord(raw) || !Array.isArray(raw.patients)) throw new ConnectorProtocolError('unexpected patient search response shape');
  return raw.patients.map((entry) => {
    if (!isRecord(entry)) throw new ConnectorProtocolError('unexpected patient entry shape');
    return toPatientMatchFromRecord(entry);
  });
}

export function toRegisteredPatient(raw: unknown): RegisteredPatient {
  if (!isRecord(raw) || !isRecord(raw.patient)) throw new ConnectorProtocolError('unexpected patient registration response shape');
  const patient = raw.patient;
  return {
    externalPatientId: requireString(patient, 'patientId'),
    displayName: `${requireString(patient, 'firstName')} ${requireString(patient, 'lastName')}`.trim(),
    contactHint: optionalString(patient, 'contactNumber'),
    externalEnquiryId: optionalString(raw, 'enquiryId'),
  };
}

export function toEnquiryReference(raw: unknown): EnquiryReference {
  if (!isRecord(raw)) throw new ConnectorProtocolError('unexpected enquiry response shape');
  return { externalEnquiryId: requireString(raw, 'enquiryId'), externalPatientId: requireString(raw, 'patientId') };
}

/** Always expects the `{ appointment: {...} }` wrapper the CMS uses for create/read/reschedule (never the flat cancel/no-show shape — see `toAppointmentCancellation`). */
export function toAppointment(raw: unknown): Appointment {
  if (!isRecord(raw) || !isRecord(raw.appointment)) throw new ConnectorProtocolError('unexpected appointment response shape');
  const record = raw.appointment;
  const status = record.status;
  if (typeof status !== 'string' || !APPOINTMENT_STATUSES.includes(status as AppointmentStatus)) {
    throw new ConnectorProtocolError('unexpected appointment status value');
  }
  const consultantId = record.consultantId;
  if (typeof consultantId !== 'number' && typeof consultantId !== 'string') throw new ConnectorProtocolError('expected consultantId in appointment response');
  return {
    externalAppointmentId: requireString(record, 'appointmentId'),
    externalPatientId: requireString(record, 'patientId'),
    externalConsultantId: String(consultantId),
    appointmentDate: requireString(record, 'appointmentDate'),
    appointmentTime: requireString(record, 'appointmentTime'),
    duration: requireNumber(record, 'duration'),
    status: status as AppointmentStatus,
    checkedInAt: optionalString(record, 'checkedInAt') ?? null,
  };
}

export function toAppointmentCancellation(raw: unknown): AppointmentCancellation {
  if (!isRecord(raw) || raw.status !== 'Cancelled') throw new ConnectorProtocolError('unexpected cancellation response shape');
  return { externalAppointmentId: requireString(raw, 'appointmentId'), status: 'Cancelled' };
}
