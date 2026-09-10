import { eq, isNull } from 'drizzle-orm';

import { assertSafeMetadata, assertSafeReason } from '../auditSafety.js';
import type { AppendAuditEventInput, AuditEventType, AuditMetadata, AuditOutcome, AuditTargetType, IdentityAuditEvent } from '../identityAuditEvent.js';
import type { IdentityAuditRepository } from '../identityAuditRepository.js';
import { withOrganizationContext, type Database } from './client.js';
import { identityAuditEvents } from './schema.js';

/**
 * Section 21 in practice: an organization-scoped event (`organizationId`
 * set) is written/read INSIDE `withOrganizationContext` — the same
 * mechanism every other RLS-protected table in this repository uses. A
 * global event (`organizationId` undefined) is written/read with NO
 * organization context set at all (a bare statement on `this.db`), which
 * under the RLS policy in drizzle/0003_identity_audit_events_security.sql
 * is the ONLY way a NULL-scoped row is visible/insertable — never both.
 */
export class PostgresIdentityAuditRepository implements IdentityAuditRepository {
  constructor(private readonly db: Database) {}

  async append(input: AppendAuditEventInput): Promise<IdentityAuditEvent> {
    assertSafeReason(input.reason);
    assertSafeMetadata(input.metadata);

    const values = {
      eventId: crypto.randomUUID(),
      organizationId: input.organizationId,
      actorIdentityId: input.actor.principalType === 'system' ? undefined : input.actor.identityId,
      actorPrincipalType: input.actor.principalType,
      eventType: input.eventType,
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: input.outcome,
      reason: input.reason,
      requestId: input.requestId,
      metadata: input.metadata ?? {},
    };

    if (input.organizationId) {
      const [row] = await withOrganizationContext(this.db, input.organizationId, (tx) =>
        tx.insert(identityAuditEvents).values(values).returning(),
      );
      return toEvent(row!);
    }
    const [row] = await this.db.insert(identityAuditEvents).values(values).returning();
    return toEvent(row!);
  }

  async listByOrganization(organizationId: string): Promise<IdentityAuditEvent[]> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx.select().from(identityAuditEvents).where(eq(identityAuditEvents.organizationId, organizationId));
      return rows.map(toEvent);
    });
  }

  async listGlobal(): Promise<IdentityAuditEvent[]> {
    const rows = await this.db.select().from(identityAuditEvents).where(isNull(identityAuditEvents.organizationId));
    return rows.map(toEvent);
  }
}

function toEvent(row: typeof identityAuditEvents.$inferSelect): IdentityAuditEvent {
  const actor =
    row.actorPrincipalType === 'system'
      ? ({ principalType: 'system' } as const)
      : ({ principalType: row.actorPrincipalType as 'human' | 'service', identityId: row.actorIdentityId! } as const);
  return Object.freeze({
    eventId: row.eventId,
    organizationId: row.organizationId ?? undefined,
    actor,
    eventType: row.eventType as AuditEventType,
    targetType: row.targetType as AuditTargetType,
    targetId: row.targetId,
    outcome: row.outcome as AuditOutcome,
    reason: row.reason ?? undefined,
    requestId: row.requestId ?? undefined,
    metadata: row.metadata as AuditMetadata,
    occurredAt: row.occurredAt.toISOString(),
  });
}
