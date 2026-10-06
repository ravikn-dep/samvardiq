import { JobFailure, JobError } from './errors.js';
import { DEFAULT_BACKOFF, backoffMs, type BackoffPolicy, type JobQueue } from './queue.js';
import { validatePayload, type JobDefinition, type JobRegistry } from './registry.js';

export type RunOutcome = 'idle' | 'SUCCEEDED' | 'RETRY_WAIT' | 'DEAD' | 'LEASE_LOST';

/** Sanitized worker event — identifiers and codes only, never a payload or an error message. */
export interface WorkerEvent {
  outcome: RunOutcome | 'store_error';
  jobId?: string;
  jobType?: string;
  attempt?: number;
  failureClass?: string;
}

export interface WorkerOptions {
  workerId: string;
  leaseMs?: number;
  backoff?: BackoffPolicy;
  random?: () => number;
  /** Optional hook for safe logging/metrics. The worker itself never logs. */
  onEvent?: (event: WorkerEvent) => void;
}

/**
 * Executes claimed jobs through the explicit registry. Holds no authority of
 * its own: the handler receives identifiers and must re-resolve its
 * organization/service authority. While a handler runs, the lease is renewed
 * every leaseMs/3 (an in-memory heartbeat — the database lease remains the
 * source of truth); if renewal fails the handler's signal is aborted and the
 * final transition is refused by fencing.
 */
export class JobWorker {
  private readonly leaseMs: number;

  constructor(
    private readonly queue: JobQueue,
    private readonly registry: JobRegistry,
    private readonly options: WorkerOptions,
  ) {
    this.leaseMs = options.leaseMs ?? 60_000;
  }

  async runOnce(): Promise<RunOutcome> {
    const job = await this.queue.claim(this.options.workerId, this.leaseMs);
    if (!job) return 'idle';

    const finish = async (kind: 'retryable' | 'permanent', failureClass: string): Promise<RunOutcome> => {
      const delay = backoffMs(job.attempt, this.options.backoff ?? DEFAULT_BACKOFF, this.options.random);
      const status = await this.queue.fail(job.jobId, job.leaseId, kind, failureClass, delay);
      const outcome = status ?? 'LEASE_LOST';
      this.options.onEvent?.({ outcome, jobId: job.jobId, jobType: job.jobType, attempt: job.attempt, failureClass });
      return outcome;
    };

    let definition: JobDefinition;
    try {
      definition = this.registry.get(job.jobType);
    } catch {
      return finish('permanent', 'unknown_job_type');
    }
    if ((definition.scope === 'organization') !== (job.organizationId !== null)) return finish('permanent', 'invalid_scope');
    let payload;
    try {
      payload = validatePayload(definition, job.payload);
    } catch {
      return finish('permanent', 'invalid_payload');
    }

    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      this.queue.renew(job.jobId, job.leaseId, this.leaseMs).then(
        (held) => {
          if (!held) controller.abort();
        },
        () => controller.abort(),
      );
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    try {
      await definition.handle({ jobId: job.jobId, jobType: job.jobType, organizationId: job.organizationId, payload, attempt: job.attempt, signal: controller.signal });
    } catch (error) {
      clearInterval(heartbeat);
      if (error instanceof JobFailure) return finish(error.kind, error.failureClass);
      // Never persist or emit the message of an unclassified error — it may carry SQL parameters, URLs or content.
      return finish('retryable', error instanceof JobError ? error.code : 'unhandled_error');
    } finally {
      clearInterval(heartbeat);
    }
    const done = await this.queue.complete(job.jobId, job.leaseId);
    const outcome: RunOutcome = done ? 'SUCCEEDED' : 'LEASE_LOST';
    this.options.onEvent?.({ outcome, jobId: job.jobId, jobType: job.jobType, attempt: job.attempt });
    return outcome;
  }

  /**
   * Polling loop until `signal` aborts. Database errors (e.g. an outage) are
   * reported as a sanitized event and retried after `pollMs` — the loop never
   * crashes and never holds work in memory: anything claimed and not finished
   * is recovered by lease expiry.
   */
  async run(signal: AbortSignal, pollMs = 5_000): Promise<void> {
    while (!signal.aborted) {
      let outcome: RunOutcome | 'store_error';
      try {
        outcome = await this.runOnce();
      } catch {
        outcome = 'store_error';
        this.options.onEvent?.({ outcome });
      }
      if (outcome === 'idle' || outcome === 'store_error') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollMs);
          signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    }
  }
}
