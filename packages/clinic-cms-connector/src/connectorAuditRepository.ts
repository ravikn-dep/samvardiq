/**
 * Connector execution evidence (section 22). Every field here is safe by
 * construction — there is no field for a secret, signature, raw request, or
 * raw response, so a correct caller cannot accidentally pass one in (a
 * caller could still misuse `safeErrorCategory`/`correlationId` as a free
 * string, but nothing here invites secret-shaped data the way a generic
 * `metadata: Record<string, unknown>` bag would).
 *
 * `actorIdentityId`/`actorPrincipalType` (CLINIC-W2B, carrying forward the
 * W2-ARCH final-review follow-up): both optional and additive — a caller
 * that predates this field (none currently do, but the type stays
 * backward-compatible on principle) still produces a valid record. Sourced
 * only from an already-resolved `TrustedOrganizationContext.identityId`/
 * `.principalType` (see `application-services/clinicOperationsHandler.ts`'s
 * `recordEvidence`) — never patient-supplied, never free text, never a
 * name/email/phone. This is what makes "who — human or service — triggered
 * this clinic operation" answerable without ever needing to store or infer
 * anything about the PATIENT the operation concerned.
 */
export interface ConnectorExecutionEvidence {
  evidenceId: string;
  organizationId: string;
  connectionId: string;
  connectorType: 'clinic-cms';
  operation: string;
  correlationId: string;
  externalResourceType?: string;
  externalResourceId?: string;
  outcome: 'SUCCESS' | 'DENIED' | 'ERROR';
  retryCount: number;
  safeErrorCategory?: string;
  actorIdentityId?: string;
  actorPrincipalType?: 'human' | 'service';
  occurredAt: string;
}

export interface ConnectorAuditRepository {
  record(evidence: ConnectorExecutionEvidence): Promise<void>;
}

export class InMemoryConnectorAuditRepository implements ConnectorAuditRepository {
  readonly records: ConnectorExecutionEvidence[] = [];

  async record(evidence: ConnectorExecutionEvidence): Promise<void> {
    this.records.push({ ...evidence });
  }
}
