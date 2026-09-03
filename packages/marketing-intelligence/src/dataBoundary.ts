/**
 * Healthcare Data Boundary (PRD "Healthcare Data Boundary" requirement).
 *
 * Marketing intelligence must never receive patient-identifying or clinical
 * information. This scans a MarketingContext for a fixed denylist of
 * clinical/patient field names and fails closed — the same posture as an
 * unregistered skill invocation — rather than silently stripping fields,
 * so a caller cannot accidentally leak clinical data by relying on
 * best-effort redaction.
 */

const CLINICAL_FIELD_KEYS = new Set(
  [
    'patientname',
    'patientid',
    'mrn',
    'phone',
    'phonenumber',
    'mobilenumber',
    'email',
    'symptoms',
    'diagnosis',
    'prescription',
    'medicalrecord',
    'medicalrecords',
    'appointmentclinicalreason',
    'clinicalreason',
    'dob',
    'dateofbirth',
  ].map((key) => key.toLowerCase()),
);

export class ClinicalDataBoundaryViolation extends Error {
  constructor(public readonly fields: string[]) {
    super(
      `Marketing context contains prohibited clinical/patient fields: ${fields.join(', ')}`,
    );
    this.name = 'ClinicalDataBoundaryViolation';
  }
}

function findClinicalFields(value: unknown, trail: string[]): string[] {
  if (value === null || typeof value !== 'object') return [];
  const hits: string[] = [];
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const path = [...trail, key].join('.');
    if (CLINICAL_FIELD_KEYS.has(key.toLowerCase())) hits.push(path);
    hits.push(...findClinicalFields(val, [...trail, key]));
  }
  return hits;
}

/** Throws ClinicalDataBoundaryViolation if any clinical field is present anywhere in context. */
export function enforceHealthcareDataBoundary(context: unknown): void {
  const found = findClinicalFields(context, []);
  if (found.length > 0) throw new ClinicalDataBoundaryViolation(found);
}
