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
 * The deterministic purge capability section 15 requires IN PLACE of a
 * real production scheduler. This is NOT itself a scheduler — nothing in
 * this codebase invokes it periodically. Production deployment must wire
 * this to an actual cron/scheduled-job mechanism (deferred — see
 * docs/integrations/CLINIC_W2_COMMUNICATION_ARCHITECTURE.md's "Known
 * Limitations"); calling it manually or via a test is what proves the
 * mechanism itself is correct.
 */
export interface RetentionPurgeRepository {
  purgeExpired(organizationId: string, now?: Date): Promise<number>;
}

export async function purgeExpiredMessageContent(repository: RetentionPurgeRepository, organizationId: string, now?: Date): Promise<number> {
  return repository.purgeExpired(organizationId, now);
}
