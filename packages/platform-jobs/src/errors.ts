/** Sanitized queue errors: fixed messages and a stable code, never a payload value, SQL text or parameter. */
export type JobErrorCode = 'invalid_job' | 'unknown_job_type' | 'idempotency_conflict' | 'store_failure';

export abstract class JobError extends Error {
  abstract readonly code: JobErrorCode;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The job definition or payload breaks the identifiers-only contract. `field` names the offending key, never its value. */
export class InvalidJobError extends JobError {
  readonly code = 'invalid_job';
  constructor(readonly field: string) {
    super(`Invalid job: ${field}.`);
  }
}

export class UnknownJobTypeError extends JobError {
  readonly code = 'unknown_job_type';
  constructor() {
    super('The job type is not registered.');
  }
}

/** The same (job type, idempotency key) already names a DIFFERENT logical job (other organization or payload). */
export class IdempotencyConflictError extends JobError {
  readonly code = 'idempotency_conflict';
  constructor() {
    super('The idempotency key is already used by a different job.');
  }
}

/** Any database failure; keeps only the SQLSTATE (ORM errors embed statement parameters). */
export class JobStoreError extends JobError {
  readonly code = 'store_failure';
  constructor(readonly sqlState: string | undefined) {
    super('The job store operation failed.');
  }
}

export async function sanitizeStoreErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof JobError) throw error;
    let sqlState: string | undefined;
    for (let e: unknown = error, depth = 0; typeof e === 'object' && e !== null && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
        sqlState = code;
        break;
      }
    }
    throw new JobStoreError(sqlState);
  }
}

/**
 * What a handler throws to classify its own failure. `failureClass` is a
 * fixed snake_case code chosen by the consumer (e.g. 'rate_limited'); it is
 * the ONLY thing persisted. Any other thrown error is recorded as
 * 'unhandled_error' (retryable) — its message is never stored.
 */
export class JobFailure extends Error {
  constructor(
    readonly kind: 'retryable' | 'permanent',
    readonly failureClass: string,
  ) {
    super(`Job failed (${kind}).`);
    this.name = 'JobFailure';
    if (!FAILURE_CLASS.test(failureClass)) throw new InvalidJobError('failureClass');
  }
}

export const FAILURE_CLASS = /^[a-z][a-z0-9_]{0,62}$/;
