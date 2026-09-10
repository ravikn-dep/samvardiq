import { assertSafeMetadata, assertSafeReason } from './auditSafety.js';
import type { AppendAuditEventInput, IdentityAuditEvent } from './identityAuditEvent.js';

/**
 * Deliberately append-oriented, not CRUD (section 22). No `update()`, no
 * `delete()` — audit events are not CRUD entities.
 *
 * Two separate, scope-explicit read methods rather than one generic
 * `get(eventId)` — this isn't incidental narrowness, it mirrors the RLS
 * design directly (see postgres/identityAuditRepository.ts): an
 * organization-scoped row is only ever visible under that organization's
 * own context, and a global row is only ever visible with NO organization
 * context set. A single `get(eventId)` would have to guess which context
 * to query under, or query under none and silently miss every
 * organization-scoped event. Both methods exist only for internal
 * verification/testing — W6 builds no tenant-facing audit-query API
 * (deferred, see session report).
 */
export interface IdentityAuditRepository {
  append(input: AppendAuditEventInput): Promise<IdentityAuditEvent>;
  listByOrganization(organizationId: string): Promise<IdentityAuditEvent[]>;
  listGlobal(): Promise<IdentityAuditEvent[]>;
}

/** Reference implementation for unit tests — no transaction/RLS semantics of its own; Postgres-backed claims are proven only against real PostgreSQL (see test/integration). */
export class InMemoryIdentityAuditRepository implements IdentityAuditRepository {
  private readonly events = new Map<string, IdentityAuditEvent>();

  async append(input: AppendAuditEventInput): Promise<IdentityAuditEvent> {
    assertSafeReason(input.reason);
    assertSafeMetadata(input.metadata);
    const event: IdentityAuditEvent = Object.freeze({
      ...input,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    });
    this.events.set(event.eventId, event);
    return event;
  }

  async listByOrganization(organizationId: string): Promise<IdentityAuditEvent[]> {
    return [...this.events.values()].filter((e) => e.organizationId === organizationId);
  }

  async listGlobal(): Promise<IdentityAuditEvent[]> {
    return [...this.events.values()].filter((e) => e.organizationId === undefined);
  }
}
