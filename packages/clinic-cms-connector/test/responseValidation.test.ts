import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConnectorProtocolError } from '../src/errors.js';
import { toAppointment, toAppointmentCancellation, toAvailableSlots, toConsultantList, toEnquiryReference, toPatientMatches, toRegisteredPatient } from '../src/responseValidation.js';

/**
 * AJ/AK: a Clinic CMS response carrying unexpected clinical-shaped fields
 * (diagnosis, prescription, clinical notes, billing, etc.) must never reach
 * a caller. Every projector below is proven against a raw payload that
 * DELIBERATELY includes such fields, asserting the returned DTO contains
 * none of them — not merely that the "normal" fields are present.
 */

const CLINICAL_POISON = {
  diagnosis: 'hypothetical clinical detail',
  prescription: 'should never appear',
  clinicalNotes: 'should never appear',
  billingAmount: 999,
  transcript: 'should never appear',
};

test('toConsultantList discards unexpected fields, including clinical-shaped ones', () => {
  const result = toConsultantList({ consultants: [{ id: 7, name: 'Dr. X', role: 'consultant', ...CLINICAL_POISON }] });
  assert.deepEqual(result, [{ externalConsultantId: '7', displayName: 'Dr. X' }]);
});

test('toPatientMatches discards unexpected fields, including clinical-shaped ones', () => {
  const result = toPatientMatches({ patients: [{ patientId: 'P1', firstName: 'A', lastName: 'B', contactNumber: '+91••••••1234', age: 30, ...CLINICAL_POISON }] });
  assert.deepEqual(result, [{ externalPatientId: 'P1', displayName: 'A B', contactHint: '+91••••••1234', age: 30 }]);
});

test('toRegisteredPatient discards unexpected fields', () => {
  const result = toRegisteredPatient({ patient: { patientId: 'P1', firstName: 'A', lastName: 'B', contactNumber: 'x', ...CLINICAL_POISON }, enquiryId: 'ENQ-1', ...CLINICAL_POISON });
  assert.deepEqual(result, { externalPatientId: 'P1', displayName: 'A B', contactHint: 'x', externalEnquiryId: 'ENQ-1' });
});

test('toAppointment discards unexpected fields, including clinical-shaped ones', () => {
  const result = toAppointment({
    appointment: {
      appointmentId: 'APT-1',
      patientId: 'P1',
      consultantId: 7,
      appointmentDate: '2026-08-13',
      appointmentTime: '10:00',
      duration: 30,
      status: 'Scheduled',
      checkedInAt: null,
      ...CLINICAL_POISON,
    },
  });
  assert.deepEqual(result, {
    externalAppointmentId: 'APT-1',
    externalPatientId: 'P1',
    externalConsultantId: '7',
    appointmentDate: '2026-08-13',
    appointmentTime: '10:00',
    duration: 30,
    status: 'Scheduled',
    checkedInAt: null,
  });
});

test('toAvailableSlots discards unexpected fields and never invents slots not present in the response', () => {
  const result = toAvailableSlots({ consultantId: 7, date: '2026-08-13', timezone: 'Asia/Kolkata', slots: ['09:00'], ...CLINICAL_POISON });
  assert.deepEqual(result, { externalConsultantId: '7', date: '2026-08-13', timezone: 'Asia/Kolkata', slots: ['09:00'] });
});

test('toEnquiryReference discards unexpected fields', () => {
  const result = toEnquiryReference({ enquiryId: 'ENQ-1', patientId: 'P1', ...CLINICAL_POISON });
  assert.deepEqual(result, { externalEnquiryId: 'ENQ-1', externalPatientId: 'P1' });
});

test('toAppointmentCancellation discards unexpected fields', () => {
  const result = toAppointmentCancellation({ appointmentId: 'APT-1', status: 'Cancelled', ...CLINICAL_POISON });
  assert.deepEqual(result, { externalAppointmentId: 'APT-1', status: 'Cancelled' });
});

test('a required field missing from the response fails closed with ConnectorProtocolError, never a partially-populated DTO', () => {
  assert.throws(() => toAppointment({ appointment: { patientId: 'P1' } }), ConnectorProtocolError);
  assert.throws(() => toConsultantList({ consultants: [{ name: 'no id' }] }), ConnectorProtocolError);
  assert.throws(() => toPatientMatches({ patients: [{ firstName: 'only-first-name' }] }), ConnectorProtocolError);
  assert.throws(() => toEnquiryReference({}), ConnectorProtocolError);
});

test('a response that is not an object at all fails closed', () => {
  assert.throws(() => toConsultantList('not an object'), ConnectorProtocolError);
  assert.throws(() => toConsultantList(null), ConnectorProtocolError);
  assert.throws(() => toConsultantList(undefined), ConnectorProtocolError);
});
