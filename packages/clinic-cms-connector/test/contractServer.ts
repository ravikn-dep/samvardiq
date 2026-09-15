import { createHmac, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A faithful local re-implementation of the Clinic CMS external API's
 * documented contract, built directly from reading clinic-cms
 * `87e3302a37ec104e5d07b7e9315f6eb690573e4b` (`server/external/router.ts`,
 * `security.ts`, `API_DOCS.md`) — NOT a copy-paste of that code (a
 * different repository/package), and NOT a reuse of this package's own
 * `hmacClient.ts` (that would only prove the client agrees with itself).
 * This is section 27's "faithful local contract test server" option,
 * independently verifying this connector's HMAC signing, replay handling,
 * idempotency, and error-shape assumptions against a second, separately
 * written implementation of the same documented algorithm.
 */

interface KeyConfig {
  secret: string;
  scopes: string[];
}

interface Patient {
  patientId: string;
  firstName: string;
  lastName: string;
  contactNumber: string;
  age?: number;
}

interface Appointment {
  appointmentId: string;
  patientId: string;
  consultantId: number;
  appointmentDate: string;
  appointmentTime: string;
  duration: number;
  status: string;
  checkedInAt: string | null;
}

export class ContractServer {
  private server?: http.Server;
  private port = 0;
  private readonly keys = new Map<string, KeyConfig>();
  private readonly seenRequestIds = new Set<string>();
  private readonly idempotency = new Map<string, { hash: string; status: number; body: unknown }>();
  private readonly patients = new Map<string, Patient>();
  private readonly enquiries = new Map<string, { patientId: string }>();
  private readonly appointments = new Map<string, Appointment>();
  private readonly bookedSlots = new Set<string>();
  /** Test control: per "METHOD path" key, how many times to simulate a dropped connection before succeeding. */
  private readonly failNextConnections = new Map<string, number>();
  private appointmentCounter = 0;
  private enquiryCounter = 0;

  registerKey(keyId: string, config: KeyConfig): void {
    this.keys.set(keyId, config);
  }

  seedPatient(patient: Patient): void {
    this.patients.set(patient.patientId, patient);
  }

  seedAppointment(appointment: Appointment): void {
    this.appointments.set(appointment.appointmentId, appointment);
  }

  /** Causes the next `count` requests matching `method path` to have their TCP connection destroyed before any response is sent (simulating a network-level failure). */
  simulateNetworkFailures(method: string, path: string, count: number): void {
    this.failNextConnections.set(`${method} ${path}`, count);
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('contract server did not bind');
    this.port = address.port;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server?.close((err) => (err ? reject(err) : resolve())));
  }

  private verifySignature(secret: string, timestamp: string, requestId: string, method: string, path: string, rawBody: string, signature: string): boolean {
    const payload = [timestamp, requestId, method.toUpperCase(), path, rawBody].join('.');
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    if (!/^[a-f0-9]{64}$/i.test(expected) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8') || '{}';
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(json);
  }

  private error(res: ServerResponse, requestId: string, status: number, code: string, message: string, retryable = false): void {
    this.send(res, status, { requestId, error: { code, message, retryable } });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const failKey = `${method} ${path}`;
    const remainingFailures = this.failNextConnections.get(failKey) ?? 0;
    if (remainingFailures > 0) {
      this.failNextConnections.set(failKey, remainingFailures - 1);
      req.socket.destroy();
      return;
    }

    const rawBody = method === 'GET' ? '{}' : await this.readBody(req);
    const requestId = String(req.headers['x-request-id'] ?? '');
    const keyId = String(req.headers['x-external-key-id'] ?? '');
    const timestamp = String(req.headers['x-external-timestamp'] ?? '');
    const signature = String(req.headers['x-external-signature'] ?? '');

    if (!keyId || !timestamp || !signature || !requestId) return this.error(res, requestId || 'unknown', 401, 'AUTH_REQUIRED', 'Authentication headers are required.');

    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
      return this.error(res, requestId, 401, 'AUTH_STALE', 'Request timestamp is invalid or outside the allowed window.');
    }

    const key = this.keys.get(keyId);
    if (!key || !this.verifySignature(key.secret, timestamp, requestId, method, path, rawBody, signature)) {
      return this.error(res, requestId, 401, 'AUTH_INVALID', 'Authentication could not be verified.');
    }

    if (this.seenRequestIds.has(`${keyId}:${requestId}`)) {
      return this.error(res, requestId, 409, 'REPLAY_DETECTED', 'Duplicate request ID detected for this service key.', true);
    }
    this.seenRequestIds.add(`${keyId}:${requestId}`);

    const requireScope = (scope: string): boolean => key.scopes.includes(scope);
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

    try {
      if (method === 'GET' && path === '/api/external/v1/health') {
        if (!requireScope('health:read')) return this.forbidden(res, requestId);
        return this.send(res, 200, { requestId, service: 'clinic-external-api', version: 'v1', status: 'ok' });
      }

      if (method === 'GET' && path === '/api/external/v1/consultants') {
        if (!requireScope('consultants:read')) return this.forbidden(res, requestId);
        return this.send(res, 200, { requestId, consultants: [{ id: 7, name: 'Dr. Test', role: 'consultant' }] });
      }

      const slotsMatch = path.match(/^\/api\/external\/v1\/consultants\/(\d+)\/slots$/);
      if (method === 'GET' && slotsMatch) {
        if (!requireScope('appointments:read')) return this.forbidden(res, requestId);
        const date = url.searchParams.get('date') ?? '';
        return this.send(res, 200, { requestId, consultantId: Number(slotsMatch[1]), date, timezone: 'Asia/Kolkata', slots: ['09:00', '09:30'] });
      }

      if (method === 'GET' && path === '/api/external/v1/patients/search') {
        if (!requireScope('patients:read')) return this.forbidden(res, requestId);
        const query = url.searchParams.get('query') ?? '';
        const matches = [...this.patients.values()].filter((p) => p.patientId.includes(query) || p.contactNumber.includes(query));
        return this.send(res, 200, { requestId, patients: matches.map((p) => ({ ...p, contactNumber: `+91••••••${p.contactNumber.slice(-4)}` })) });
      }

      if (method === 'POST' && path === '/api/external/v1/patients') {
        if (!requireScope('patients:write')) return this.forbidden(res, requestId);
        return this.handleIdempotent(res, requestId, 'patients.create', req, rawBody, () => {
          const patientId = `PAT-${String(this.patients.size + 1).padStart(4, '0')}`;
          const patient: Patient = { patientId, firstName: String(body.firstName), lastName: String(body.lastName), contactNumber: String(body.contactNumber) };
          this.patients.set(patientId, patient);
          let enquiryId: string | undefined;
          if (body.enquiry) {
            this.enquiryCounter += 1;
            enquiryId = `ENQ-${this.enquiryCounter}`;
            this.enquiries.set(enquiryId, { patientId });
          }
          return { status: 201, body: { patient: { patientId, firstName: patient.firstName, lastName: patient.lastName, contactNumber: `+91••••••${patient.contactNumber.slice(-4)}` }, enquiryId } };
        });
      }

      const enquiryMatch = path.match(/^\/api\/external\/v1\/patients\/([^/]+)\/enquiries$/);
      if (method === 'POST' && enquiryMatch) {
        if (!requireScope('enquiries:write')) return this.forbidden(res, requestId);
        const patientId = decodeURIComponent(enquiryMatch[1]!);
        if (!this.patients.has(patientId)) return this.error(res, requestId, 404, 'NOT_FOUND', 'Patient not found.');
        return this.handleIdempotent(res, requestId, 'enquiries.create', req, rawBody, () => {
          this.enquiryCounter += 1;
          const enquiryId = `ENQ-${this.enquiryCounter}`;
          this.enquiries.set(enquiryId, { patientId });
          return { status: 201, body: { enquiryId, patientId } };
        });
      }

      if (method === 'POST' && path === '/api/external/v1/appointments') {
        if (!requireScope('appointments:write')) return this.forbidden(res, requestId);
        const consultantId = Number(body.consultantId);
        const slotKey = `${consultantId}:${body.appointmentDate}:${body.appointmentTime}`;
        return this.handleIdempotent(res, requestId, 'appointments.create', req, rawBody, () => {
          if (this.bookedSlots.has(slotKey)) return { status: 409, body: { error: { code: 'SLOT_UNAVAILABLE', message: 'The requested slot is no longer available.', retryable: true } } };
          this.bookedSlots.add(slotKey);
          this.appointmentCounter += 1;
          const appointmentId = `APT-${this.appointmentCounter}`;
          const appointment: Appointment = {
            appointmentId,
            patientId: String(body.patientId),
            consultantId,
            appointmentDate: String(body.appointmentDate),
            appointmentTime: String(body.appointmentTime),
            duration: Number(body.duration ?? 30),
            status: 'Scheduled',
            checkedInAt: null,
          };
          this.appointments.set(appointmentId, appointment);
          return { status: 201, body: { appointment } };
        });
      }

      const appointmentIdMatch = path.match(/^\/api\/external\/v1\/appointments\/([^/]+)$/);
      if (method === 'GET' && appointmentIdMatch) {
        if (!requireScope('appointments:read')) return this.forbidden(res, requestId);
        const appointment = this.appointments.get(decodeURIComponent(appointmentIdMatch[1]!));
        if (!appointment) return this.error(res, requestId, 404, 'NOT_FOUND', 'Appointment not found.');
        return this.send(res, 200, { requestId, appointment });
      }

      const rescheduleMatch = path.match(/^\/api\/external\/v1\/appointments\/([^/]+)\/reschedule$/);
      if (method === 'POST' && rescheduleMatch) {
        if (!requireScope('appointments:write')) return this.forbidden(res, requestId);
        const appointment = this.appointments.get(decodeURIComponent(rescheduleMatch[1]!));
        if (!appointment) return this.error(res, requestId, 404, 'NOT_FOUND', 'Appointment not found.');
        appointment.appointmentDate = String(body.appointmentDate);
        appointment.appointmentTime = String(body.appointmentTime);
        appointment.status = 'Rescheduled';
        return this.send(res, 200, { requestId, appointment });
      }

      const cancelMatch = path.match(/^\/api\/external\/v1\/appointments\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        if (!requireScope('appointments:write')) return this.forbidden(res, requestId);
        const appointment = this.appointments.get(decodeURIComponent(cancelMatch[1]!));
        if (!appointment) return this.error(res, requestId, 404, 'NOT_FOUND', 'Appointment not found.');
        appointment.status = 'Cancelled';
        return this.send(res, 200, { requestId, appointmentId: appointment.appointmentId, status: 'Cancelled' });
      }

      return this.error(res, requestId, 404, 'NOT_FOUND', 'Route not found.');
    } catch {
      return this.error(res, requestId, 500, 'INTERNAL_ERROR', 'The request could not be completed.', true);
    }
  }

  private forbidden(res: ServerResponse, requestId: string): void {
    this.error(res, requestId, 403, 'SCOPE_FORBIDDEN', 'The external service is not authorized for this operation.');
  }

  private async handleIdempotent(
    res: ServerResponse,
    requestId: string,
    operation: string,
    req: IncomingMessage,
    rawBody: string,
    handler: () => { status: number; body: unknown },
  ): Promise<void> {
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
    if (!idempotencyKey) return this.error(res, requestId, 400, 'IDEMPOTENCY_REQUIRED', 'A valid Idempotency-Key header is required.');
    const hash = createHmac('sha256', 'contract-server-hash').update(rawBody).digest('hex');
    const key = `${operation}:${idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.hash !== hash) return this.error(res, requestId, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different request.');
      return this.send(res, existing.status, { requestId, ...(existing.body as object) });
    }
    const result = handler();
    if (result.status < 300) this.idempotency.set(key, { hash, status: result.status, body: result.body });
    this.send(res, result.status, { requestId, ...(result.body as object) });
  }
}
