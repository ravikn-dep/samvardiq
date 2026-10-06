/**
 * Founder-approved pilot retention rule (CLINIC-W2 Decision 2): raw
 * message content may be retained for a MAXIMUM of 30 days. This constant
 * is the single source of truth every write path uses — there is no
 * indefinite-retention code path anywhere in this package.
 */
export const RAW_MESSAGE_RETENTION_DAYS = 30;

export function computePurgeAfter(from: Date = new Date()): string {
  const purgeAfter = new Date(from);
  purgeAfter.setUTCDate(purgeAfter.getUTCDate() + RAW_MESSAGE_RETENTION_DAYS);
  return purgeAfter.toISOString();
}

/**
 * The deterministic purge capability (section 15). It is invoked hourly per
 * organization by the `communication.retention_purge` platform-maintenance job
 * (retentionMaintenance.ts, ARCH-021); this interface is that job's ONLY
 * capability.
 */
export interface RetentionPurgeRepository {
  purgeExpired(organizationId: string, now?: Date): Promise<number>;
}

export async function purgeExpiredMessageContent(repository: RetentionPurgeRepository, organizationId: string, now?: Date): Promise<number> {
  return repository.purgeExpired(organizationId, now);
}
