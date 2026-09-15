import type { ConnectorAuditRepository, ConnectorExecutionEvidence } from '../connectorAuditRepository.js';
import { withOrganizationContext, type Database } from './client.js';
import { clinicCmsConnectorEvidence } from './schema.js';

export class PostgresConnectorAuditRepository implements ConnectorAuditRepository {
  constructor(private readonly db: Database) {}

  async record(evidence: ConnectorExecutionEvidence): Promise<void> {
    await withOrganizationContext(this.db, evidence.organizationId, async (tx) => {
      await tx.insert(clinicCmsConnectorEvidence).values({
        organizationId: evidence.organizationId,
        evidenceId: evidence.evidenceId,
        connectionId: evidence.connectionId,
        connectorType: evidence.connectorType,
        operation: evidence.operation,
        correlationId: evidence.correlationId,
        externalResourceType: evidence.externalResourceType ?? null,
        externalResourceId: evidence.externalResourceId ?? null,
        outcome: evidence.outcome,
        retryCount: evidence.retryCount,
        safeErrorCategory: evidence.safeErrorCategory ?? null,
      });
    });
  }
}
