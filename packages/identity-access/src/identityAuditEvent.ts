/**
 * IDENTITY-W6 — identity security audit domain model (ADR-IDENTITY-001
 * "Audit Requirements"). A dedicated, narrow model — NOT a generic
 * application log, NOT a CRUD entity. See identityAuditRepository.ts for
 * why the repository contract exposes no update/delete.
 */

/** 'system' represents a server-internal actor with no human/service identity behind it (e.g. a scheduled integrity job) — never invented for an action a real identity actually took. */
export type AuditActorPrincipalType = 'human' | 'service' | 'system';

/**
 * The actor of a security event. Structurally cannot represent a
 * client-forged identity: `identityId` only exists on the human/service
 * variant, and this type is only ever constructed from server-established
 * authority (a TrustedOrganizationContext, or an internal system caller) —
 * never from raw request input. See requestBoundary-equivalent guidance in
 * ADR-IDENTITY-001 and section 26 of the IDENTITY-W6 session brief.
 */
export type AuditActor = { principalType: 'human' | 'service'; identityId: string } | { principalType: 'system' };

export type AuditTargetType = 'IDENTITY' | 'MEMBERSHIP' | 'PROVIDER_LINK';

/**
 * Controlled vocabulary (section 12) — deliberately not open-ended.
 * AUTHENTICATION_FAILED/AUTHORIZATION_FAILED are named here for schema
 * readiness (ADR-IDENTITY-001 lists "failed authentication" as an
 * eventually-covered event) but IDENTITY-W6 writes no code path that
 * persists them to this durable table — see identityAuditPolicy.ts for the
 * documented reasoning (high-volume unauthenticated-request DoS surface).
 */
export type AuditEventType =
  | 'IDENTITY_CREATED'
  | 'IDENTITY_STATUS_CHANGED'
  | 'PROVIDER_LINK_CREATED'
  | 'PROVIDER_LINK_REMOVED'
  | 'MEMBERSHIP_CREATED'
  | 'MEMBERSHIP_STATUS_CHANGED'
  | 'MEMBERSHIP_ROLE_CHANGED'
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_FAILED';

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILED';

/**
 * Strictly bounded (section 15) — primitive values only, allow-listed keys
 * only (see auditSafety.ts). Never a free-form `Record<string, unknown>`
 * dumped from a request body.
 */
export type AuditMetadata = Readonly<Record<string, string | number | boolean>>;

/**
 * What a caller supplies to append an event. Deliberately excludes
 * `eventId` (repository/coordinator-generated via crypto.randomUUID(), the
 * same convention already used for approvalRecordId/recommendationId — see
 * approval-governance/src/governance.ts) and `occurredAt` (database-
 * generated — section 17, never a caller-supplied value).
 */
export interface AppendAuditEventInput {
  /** Required for MEMBERSHIP_* events, forbidden for IDENTITY_* or PROVIDER_LINK_* events — enforced at the database layer too (schema.ts check constraint). */
  organizationId?: string;
  actor: AuditActor;
  eventType: AuditEventType;
  targetType: AuditTargetType;
  targetId: string;
  outcome: AuditOutcome;
  /** Bounded, non-secret, non-clinical — see auditSafety.ts. Never raw exception text. */
  reason?: string;
  /** Observability correlation only — never authority, never identity, never tenant scope (section 16/AG). */
  requestId?: string;
  metadata?: AuditMetadata;
}

/** The durable, persisted shape — includes the two fields the repository/database controls. */
export interface IdentityAuditEvent extends AppendAuditEventInput {
  readonly eventId: string;
  readonly occurredAt: string;
}
