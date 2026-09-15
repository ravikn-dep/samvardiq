/**
 * Contracts for the Clinic CMS connector (CLINIC-W1B-2).
 *
 * Every DTO here is a deliberately minimized projection of the Clinic CMS
 * external API's own response shape (verified against clinic-cms
 * `87e3302a37ec104e5d07b7e9315f6eb690573e4b`, `server/external/API_DOCS.md`)
 * — never a pass-through of the raw remote JSON. See responseValidation.ts
 * for where unknown/unexpected remote fields are discarded rather than
 * propagated.
 *
 * `appointments:complete` is intentionally absent from `ClinicCmsScope` —
 * Samvardiq never requests or requires that scope (CLINIC-W1B-2 brief,
 * section 12).
 */

export type ClinicCmsScope =
  | 'health:read'
  | 'patients:read'
  | 'patients:write'
  | 'consultants:read'
  | 'appointments:read'
  | 'appointments:write'
  | 'enquiries:write';

/**
 * Organization-scoped connector configuration. The raw HMAC secret is
 * NEVER a field here — `secretReference` is an opaque pointer a
 * `ConnectorSecretProvider` resolves separately, so this type (and any
 * repository row/response built from it) can be logged, serialized, or
 * returned from a query without ever risking secret disclosure.
 */
export interface ClinicCmsConnection {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly baseUrl: string;
  readonly keyId: string;
  readonly secretReference: string;
  readonly approvedScopes: ClinicCmsScope[];
  readonly timezone: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EnquiryChannel = 'VOICE' | 'WHATSAPP' | 'PHONE' | 'WALK_IN' | 'WEBSITE' | 'GOOGLE' | 'INSTAGRAM' | 'REFERRAL' | 'OTHER';
export type PreferredLanguage = 'en-IN' | 'hi-IN' | 'te-IN' | 'mixed';
export type AppointmentStatus = 'Scheduled' | 'Rescheduled' | 'Cancelled' | 'Completed' | 'No-show';

export interface ConnectorHealth {
  status: 'ok';
}

export interface ConsultantSummary {
  externalConsultantId: string;
  displayName: string;
}

export interface AvailableSlots {
  externalConsultantId: string;
  date: string;
  timezone: string;
  slots: string[];
}

/** `contactHint` is whatever the CMS itself returns — already masked (`+91••••••NNNN`) by CLINIC-W1B-1; never re-derived or unmasked here. */
export interface PatientMatch {
  externalPatientId: string;
  displayName: string;
  contactHint?: string;
  age?: number | null;
}

export interface RegisteredPatient {
  externalPatientId: string;
  displayName: string;
  contactHint?: string;
  externalEnquiryId?: string;
}

export interface EnquiryReference {
  externalEnquiryId: string;
  externalPatientId: string;
}

export interface Appointment {
  externalAppointmentId: string;
  externalPatientId: string;
  externalConsultantId: string;
  appointmentDate: string;
  appointmentTime: string;
  duration: number;
  status: AppointmentStatus;
  checkedInAt: string | null;
}

export interface AppointmentCancellation {
  externalAppointmentId: string;
  status: 'Cancelled';
}

export interface FindPatientsInput {
  query: string;
}

export interface RegisterPatientInput {
  firstName: string;
  lastName: string;
  age?: number;
  gender?: 'Male' | 'Female' | 'Other';
  contactNumber: string;
  email?: string;
  address?: string;
  enquiry?: {
    channel: EnquiryChannel;
    sourceDetail?: string;
    preferredLanguage: PreferredLanguage;
  };
}

export interface CreateEnquiryInput {
  externalPatientId: string;
  channel: EnquiryChannel;
  sourceDetail?: string;
  preferredLanguage: PreferredLanguage;
}

export interface CreateAppointmentInput {
  externalPatientId: string;
  externalConsultantId: string;
  appointmentDate: string;
  appointmentTime: string;
  duration?: number;
  notes?: string;
  externalEnquiryId?: string;
}

export interface RescheduleAppointmentInput {
  appointmentDate: string;
  appointmentTime: string;
}

/**
 * Every write operation that must preserve a stable logical identity across
 * retried HTTP attempts (section 16) carries its own caller-supplied
 * `idempotencyKey` — never derived from PII (phone/name/email), always a
 * value the caller controls and can regenerate deliberately for a genuinely
 * new logical mutation.
 */
export interface IdempotentOperation {
  idempotencyKey: string;
}
