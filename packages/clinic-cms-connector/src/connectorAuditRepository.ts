/**
 * Connector execution evidence (section 22). Every field here is safe by
 * construction — there is no field for a secret, signature, raw request, or
 * raw response, so a correct caller cannot accidentally pass one in (a
 * caller could still misuse `safeErrorCategory`/`correlationId` as a free
 * string, but nothing here invites secret-shaped data the way a generic
 * `metadata: Record<string, unknown>` bag would).
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
