import { InvalidJobError, UnknownJobTypeError } from './errors.js';

/**
 * Identifiers-only payloads, enforced structurally (ARCH-021). Each job type
 * declares an allow-list of payload keys, each with one of these kinds; any
 * other key, nesting, free text or oversized value is rejected before the
 * job is persisted (and again before a handler runs).
 */
export type PayloadKind = 'id' | 'date' | 'int';
export type JobPayload = Readonly<Record<string, string | number>>;

const VALUE: Record<PayloadKind, (v: unknown) => boolean> = {
  // An identifier: no whitespace, quotes, brackets or other free-text characters.
  id: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(v),
  date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
  int: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
};
const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;
// Key names that would invite secrets, contact/patient data or content — refused even if a definition declares them.
const FORBIDDEN_KEY = /token|secret|password|passwd|credential|apikey|auth|cookie|session|bearer|private|signature|phone|email|mobile|address|name|patient|diagnos|clinical|symptom|message|text|body|content|review|comment|note|document|url|uri|link|script|code|eval|command/i;
// Recognizable credential shapes that the id alphabet could otherwise admit.
const TOKEN_SHAPE = /^(eyJ|ya29\.|1\/\/|sk_|pk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|ASIA|EAA[A-Za-z0-9]{8}|AIza)/;
export const MAX_PAYLOAD_BYTES = 1024;
const MAX_KEYS = 8;

export interface JobContext {
  jobId: string;
  jobType: string;
  /** An identifier to re-resolve authority from — never authority itself. */
  organizationId: string | null;
  payload: JobPayload;
  attempt: number;
  /** Aborted when the worker loses its lease (renewal failed); the handler should stop promptly. */
  signal: AbortSignal;
}

export interface JobDefinition {
  /** Stable identifier stored in the database, e.g. 'communication.retention_purge'. */
  type: string;
  payload: Readonly<Record<string, PayloadKind>>;
  /** Whether jobs of this type are organization-scoped (organizationId required) or platform maintenance (must be null). */
  scope: 'organization' | 'platform';
  maxAttempts: number;
  /**
   * Must be idempotent (at-least-once delivery) and must re-resolve its own
   * authority from `organizationId`. Throw JobFailure to classify a failure.
   */
  handle(job: JobContext): Promise<void>;
}

const TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function validatePayload(definition: JobDefinition, payload: unknown): JobPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new InvalidJobError('payload');
  }
  const entries = Object.entries(payload);
  if (entries.length > MAX_KEYS) throw new InvalidJobError('payload');
  for (const [key, value] of entries) {
    const kind = Object.hasOwn(definition.payload, key) ? definition.payload[key] : undefined;
    if (!kind || !KEY.test(key) || FORBIDDEN_KEY.test(key)) throw new InvalidJobError('payload key');
    if (!VALUE[kind](value) || (typeof value === 'string' && TOKEN_SHAPE.test(value))) throw new InvalidJobError(`payload.${key}`);
  }
  const frozen = Object.freeze(Object.fromEntries(entries)) as JobPayload;
  if (Buffer.byteLength(JSON.stringify(frozen)) > MAX_PAYLOAD_BYTES) throw new InvalidJobError('payload size');
  return frozen;
}

/** Explicit job type → handler map. The database stores only the type string; nothing is ever imported or evaluated from it. */
export class JobRegistry {
  readonly #definitions = new Map<string, JobDefinition>();

  register(definition: JobDefinition): this {
    if (!TYPE.test(definition.type) || definition.type.length > 64) throw new InvalidJobError('type');
    if (this.#definitions.has(definition.type)) throw new InvalidJobError('type already registered');
    if (!Number.isSafeInteger(definition.maxAttempts) || definition.maxAttempts < 1 || definition.maxAttempts > 25) throw new InvalidJobError('maxAttempts');
    for (const [key, kind] of Object.entries(definition.payload)) {
      if (!KEY.test(key) || FORBIDDEN_KEY.test(key) || !Object.hasOwn(VALUE, kind)) throw new InvalidJobError('payload definition');
    }
    this.#definitions.set(definition.type, Object.freeze({ ...definition, payload: Object.freeze({ ...definition.payload }) }));
    return this;
  }

  /** The job types this registry can execute — a worker claims only these. */
  types(): string[] {
    return [...this.#definitions.keys()];
  }

  get(type: string): JobDefinition {
    const definition = this.#definitions.get(type);
    if (!definition) throw new UnknownJobTypeError();
    return definition;
  }
}
