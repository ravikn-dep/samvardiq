/**
 * Bounded exponential backoff with jitter (section 17). No unbounded loops:
 * `maxAttempts` is a hard ceiling, always reached or exceeded exactly once
 * before giving up.
 */
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const READ_RETRY: RetryOptions = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };
export const IDEMPOTENT_WRITE_RETRY: RetryOptions = { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 };

export function backoffDelayMs(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  return Math.floor(capped * (0.5 + Math.random() * 0.5));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
