import { randomUUID } from 'node:crypto';

import { JobError, JobWorker, runScheduleTick, type JobQueue, type JobRegistry, type ScheduleDefinition, type WorkerEvent } from '@samvardiq/platform-jobs';

/**
 * PLATFORM-JOBS-W1 hosting, Option A: the API process is the CURRENT
 * execution host for the ARCH-021 worker and schedule tick. PostgreSQL owns
 * durability; nothing here is a source of truth:
 *
 * - worker: claims one due job at a time (SKIP LOCKED + fenced lease), polls
 *   every WORKER_POLL_MS when idle;
 * - scheduler: evaluates the code-defined schedules at startup and every
 *   SCHEDULER_INTERVAL_MS; per-period idempotency keys make every evaluation
 *   after the first in a period a no-op.
 *
 * Both are independently enabled (JOBS_WORKER_ENABLED / JOBS_SCHEDULER_ENABLED)
 * and safe to run in several processes at once. A loop failure is logged as a
 * sanitized code and retried next iteration; it never crashes the API and never
 * affects /health. On stop: no new tick, no new claim; an in-flight handler is
 * signalled to stop and, if it cannot finish, its lease expires and the job is
 * reclaimed — nothing is force-completed.
 */
export const WORKER_POLL_MS = 10_000;
export const WORKER_LEASE_MS = 300_000;
export const SCHEDULER_INTERVAL_MS = 300_000;

export interface JobsHostLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsHostOptions {
  worker: boolean;
  scheduler: boolean;
  queue: JobQueue;
  registry: JobRegistry;
  schedules: readonly ScheduleDefinition[];
  log: JobsHostLogger;
  workerPollMs?: number;
  schedulerIntervalMs?: number;
  leaseMs?: number;
}

export interface JobsHost {
  readonly workerId: string | null;
  stop(): Promise<void>;
}

const errorCode = (error: unknown) => (error instanceof JobError ? error.code : 'unexpected_error');

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

export function startJobsHost(options: JobsHostOptions): JobsHost {
  const controller = new AbortController();
  const { signal } = controller;
  const tasks: Promise<void>[] = [];
  let workerId: string | null = null;

  if (options.worker) {
    workerId = `api-${process.pid}-${randomUUID().slice(0, 8)}`;
    const onEvent = (event: WorkerEvent) => {
      // Identifiers and codes only — WorkerEvent carries no payload and no error text.
      if (event.outcome === 'SUCCEEDED') options.log.info({ ...event }, 'job succeeded');
      else options.log.warn({ ...event }, 'job not completed');
    };
    const worker = new JobWorker(options.queue, options.registry, { workerId, leaseMs: options.leaseMs ?? WORKER_LEASE_MS, onEvent });
    tasks.push(worker.run(signal, options.workerPollMs ?? WORKER_POLL_MS));
    options.log.info({ workerId }, 'jobs worker started');
  }

  if (options.scheduler) {
    const interval = options.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS;
    tasks.push(
      (async () => {
        while (!signal.aborted) {
          try {
            const result = await runScheduleTick(options.queue, options.schedules);
            if (result.enqueued > 0) options.log.info({ ...result }, 'jobs schedule tick enqueued work');
          } catch (error) {
            options.log.warn({ errorCode: errorCode(error) }, 'jobs schedule tick failed');
          }
          await sleep(interval, signal);
        }
      })(),
    );
    options.log.info({ schedules: options.schedules.map((s) => s.name) }, 'jobs scheduler started');
  }

  return {
    workerId,
    async stop() {
      controller.abort();
      await Promise.allSettled(tasks);
    },
  };
}
