import { ClinicCmsHttpClient, type ClinicCmsHttpClientConfig } from './cmsHttpClient.js';
import { IDEMPOTENT_WRITE_RETRY, READ_RETRY } from './retryPolicy.js';
import {
  toAppointment,
  toAppointmentCancellation,
  toAvailableSlots,
  toConnectorHealth,
  toConsultantList,
  toEnquiryReference,
  toPatientMatches,
  toRegisteredPatient,
} from './responseValidation.js';
import type {
  Appointment,
  AppointmentCancellation,
  AvailableSlots,
  ConnectorHealth,
  ConsultantSummary,
  CreateAppointmentInput,
  CreateEnquiryInput,
  EnquiryReference,
  FindPatientsInput,
  IdempotentOperation,
  PatientMatch,
  RegisterPatientInput,
  RegisteredPatient,
  RescheduleAppointmentInput,
} from './types.js';

const EXTERNAL_API_PREFIX = '/api/external/v1';

/**
 * The full set of Clinic CMS operations Samvardiq is permitted to use
 * (section 11/24). Hard exclusions — `completeAppointment`, `checkIn`,
 * `markNoShow`, and anything billing/consultation/clinical-record-shaped —
 * do not exist anywhere on this interface. Adding one would require a
 * conscious, reviewed change to this file, not an accidental one.
 */
export interface ClinicOperationsConnector {
  checkHealth(): Promise<ConnectorHealth>;
  listConsultants(): Promise<ConsultantSummary[]>;
  getAvailableSlots(input: { externalConsultantId: string; date: string }): Promise<AvailableSlots>;
  findPatients(input: FindPatientsInput): Promise<PatientMatch[]>;
  registerPatient(input: RegisterPatientInput & IdempotentOperation): Promise<RegisteredPatient>;
  createEnquiry(input: CreateEnquiryInput & IdempotentOperation): Promise<EnquiryReference>;
  createAppointment(input: CreateAppointmentInput & IdempotentOperation): Promise<Appointment>;
  getAppointment(externalAppointmentId: string): Promise<Appointment>;
  rescheduleAppointment(externalAppointmentId: string, input: RescheduleAppointmentInput): Promise<Appointment>;
  cancelAppointment(externalAppointmentId: string): Promise<AppointmentCancellation>;
}

export class ClinicCmsOperationsConnector implements ClinicOperationsConnector {
  private readonly http: ClinicCmsHttpClient;

  constructor(config: ClinicCmsHttpClientConfig) {
    this.http = new ClinicCmsHttpClient(config);
  }

  async checkHealth(): Promise<ConnectorHealth> {
    return this.http.request({ path: `${EXTERNAL_API_PREFIX}/health`, method: 'GET', retry: READ_RETRY, networkFailurePolicy: 'retry' }, toConnectorHealth);
  }

  async listConsultants(): Promise<ConsultantSummary[]> {
    return this.http.request({ path: `${EXTERNAL_API_PREFIX}/consultants`, method: 'GET', retry: READ_RETRY, networkFailurePolicy: 'retry' }, toConsultantList);
  }

  async getAvailableSlots(input: { externalConsultantId: string; date: string }): Promise<AvailableSlots> {
    const path = `${EXTERNAL_API_PREFIX}/consultants/${encodeURIComponent(input.externalConsultantId)}/slots?date=${encodeURIComponent(input.date)}`;
    return this.http.request({ path, method: 'GET', retry: READ_RETRY, networkFailurePolicy: 'retry' }, toAvailableSlots);
  }

  async findPatients(input: FindPatientsInput): Promise<PatientMatch[]> {
    const path = `${EXTERNAL_API_PREFIX}/patients/search?query=${encodeURIComponent(input.query)}`;
    return this.http.request({ path, method: 'GET', retry: READ_RETRY, networkFailurePolicy: 'retry' }, toPatientMatches);
  }

  async registerPatient(input: RegisterPatientInput & IdempotentOperation): Promise<RegisteredPatient> {
    const { idempotencyKey, ...body } = input;
    return this.http.request(
      { path: `${EXTERNAL_API_PREFIX}/patients`, method: 'POST', body, idempotencyKey, retry: IDEMPOTENT_WRITE_RETRY, networkFailurePolicy: 'retry' },
      toRegisteredPatient,
    );
  }

  async createEnquiry(input: CreateEnquiryInput & IdempotentOperation): Promise<EnquiryReference> {
    const { idempotencyKey, externalPatientId, ...body } = input;
    return this.http.request(
      {
        path: `${EXTERNAL_API_PREFIX}/patients/${encodeURIComponent(externalPatientId)}/enquiries`,
        method: 'POST',
        body,
        idempotencyKey,
        retry: IDEMPOTENT_WRITE_RETRY,
        networkFailurePolicy: 'retry',
      },
      toEnquiryReference,
    );
  }

  async createAppointment(input: CreateAppointmentInput & IdempotentOperation): Promise<Appointment> {
    const { idempotencyKey, externalPatientId, externalConsultantId, externalEnquiryId, ...rest } = input;
    const body = { ...rest, patientId: externalPatientId, consultantId: externalConsultantId, enquiryId: externalEnquiryId };
    return this.http.request(
      { path: `${EXTERNAL_API_PREFIX}/appointments`, method: 'POST', body, idempotencyKey, retry: IDEMPOTENT_WRITE_RETRY, networkFailurePolicy: 'retry' },
      toAppointment,
    );
  }

  async getAppointment(externalAppointmentId: string): Promise<Appointment> {
    const path = `${EXTERNAL_API_PREFIX}/appointments/${encodeURIComponent(externalAppointmentId)}`;
    return this.http.request({ path, method: 'GET', retry: READ_RETRY, networkFailurePolicy: 'retry' }, toAppointment);
  }

  /** Section 17/AV: the CMS requires no Idempotency-Key for reschedule, so a network-level failure here is genuinely ambiguous — never auto-retried. */
  async rescheduleAppointment(externalAppointmentId: string, input: RescheduleAppointmentInput): Promise<Appointment> {
    const path = `${EXTERNAL_API_PREFIX}/appointments/${encodeURIComponent(externalAppointmentId)}/reschedule`;
    return this.http.request({ path, method: 'POST', body: input, networkFailurePolicy: 'ambiguous' }, toAppointment);
  }

  /** Section 17/AW: same reasoning as reschedule — cancel has no Idempotency-Key guard on the CMS side. */
  async cancelAppointment(externalAppointmentId: string): Promise<AppointmentCancellation> {
    const path = `${EXTERNAL_API_PREFIX}/appointments/${encodeURIComponent(externalAppointmentId)}/cancel`;
    return this.http.request({ path, method: 'POST', body: {}, networkFailurePolicy: 'ambiguous' }, toAppointmentCancellation);
  }
}
