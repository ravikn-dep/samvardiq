import { InvalidJobError } from './errors.js';
import type { JobQueue } from './queue.js';
import type { JobPayload } from './registry.js';

export interface ScheduleTarget {
  organizationId: string | null;
  /** Identifies the target within the period; part of the idempotency key. */
  key: string;
  payload: JobPayload;
}

/**
 * A code-defined schedule (ARCH-021: schedules live in code, separate from
 * execution). Cadence is a fixed period; each period has a deterministic
 * start, so the idempotency key `<name>:<periodStart>:<target>` makes ticks
 * safe to run twice, late or concurrently. There is no cron syntax and no
 * stored schedule.
 */
export interface ScheduleDefinition {
  name: string;
  jobType: string;
  periodMs: number;
  /** Eligible targets for this period (e.g. organizations with an active resource). Identifiers only. */
  targets(period: { start: Date }): Promise<ScheduleTarget[]>;
}

const NAME = /^[a-z][a-z0-9_.]{0,39}$/;

/**
 * One tick: enqueue every due (schedule, period, target) job. Hosting decides
 * what calls this (a scheduled trigger, a loop) — the queue's unique key, not
 * the trigger, guarantees one logical job per period. A missed period is not
 * back-filled: the next tick enqueues the current period only.
 */
export async function runScheduleTick(queue: JobQueue, schedules: readonly ScheduleDefinition[], now: Date = new Date()): Promise<{ enqueued: number; existing: number }> {
  let enqueued = 0;
  let existing = 0;
  for (const schedule of schedules) {
    if (!NAME.test(schedule.name) || !Number.isSafeInteger(schedule.periodMs) || schedule.periodMs < 60_000) throw new InvalidJobError('schedule');
    const start = new Date(Math.floor(now.getTime() / schedule.periodMs) * schedule.periodMs);
    const period = start.toISOString().replace(/\.000Z$/, 'Z');
    for (const target of await schedule.targets({ start })) {
      const result = await queue.enqueue({
        type: schedule.jobType,
        organizationId: target.organizationId,
        idempotencyKey: `${schedule.name}:${period}:${target.key}`,
        payload: target.payload,
      });
      if (result.created) enqueued += 1;
      else existing += 1;
    }
  }
  return { enqueued, existing };
}
