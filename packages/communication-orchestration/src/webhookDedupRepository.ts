/**
 * Platform-global replay/duplicate protection (section 13/32.U/V) — NOT
 * organization-scoped, matching the same precedent identity-access already
 * established for `identities`/`identity_provider_links` (a wamid is
 * provider-global, not tenant data). `reserve` must be atomic:
 * "insert if absent" — see the Postgres implementation's unique-constraint
 * based approach, which is what actually makes this collision-safe under
 * concurrent delivery, not merely a check-then-insert race.
 */
export interface WebhookEventDedupRepository {
  /** Returns true if this is the first time this event has been seen (and records it); false if it was already seen. */
  reserve(provider: string, externalEventId: string): Promise<boolean>;
}

export class InMemoryWebhookEventDedupRepository implements WebhookEventDedupRepository {
  private readonly seen = new Set<string>();

  async reserve(provider: string, externalEventId: string): Promise<boolean> {
    const key = `${provider}::${externalEventId}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
