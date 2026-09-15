import { and, eq } from 'drizzle-orm';

import type { ClinicCmsConnectionRepository } from '../connectionRepository.js';
import type { ClinicCmsConnection, ClinicCmsScope } from '../types.js';
import { withOrganizationContext, type Database } from './client.js';
import { clinicCmsConnections } from './schema.js';

function toConnection(row: typeof clinicCmsConnections.$inferSelect): ClinicCmsConnection {
  return {
    connectionId: row.connectionId,
    organizationId: row.organizationId,
    baseUrl: row.baseUrl,
    keyId: row.keyId,
    secretReference: row.secretReference,
    approvedScopes: row.approvedScopes as ClinicCmsScope[],
    timezone: row.timezone,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * RLS-backed: every method runs inside `withOrganizationContext`, so a
 * connection row for a different organization is structurally invisible to
 * this connection regardless of what the application code asks for —
 * defense-in-depth alongside the explicit `organizationId` WHERE clause
 * below (section E/F/G of the adversarial matrix).
 */
export class PostgresClinicCmsConnectionRepository implements ClinicCmsConnectionRepository {
  constructor(private readonly db: Database) {}

  async getEnabledForOrganization(organizationId: string): Promise<ClinicCmsConnection | null> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(clinicCmsConnections)
        .where(and(eq(clinicCmsConnections.organizationId, organizationId), eq(clinicCmsConnections.enabled, true)))
        .limit(1);
      return rows[0] ? toConnection(rows[0]) : null;
    });
  }

  async create(connection: ClinicCmsConnection): Promise<ClinicCmsConnection> {
    return withOrganizationContext(this.db, connection.organizationId, async (tx) => {
      const [row] = await tx
        .insert(clinicCmsConnections)
        .values({
          organizationId: connection.organizationId,
          connectionId: connection.connectionId,
          baseUrl: connection.baseUrl,
          keyId: connection.keyId,
          secretReference: connection.secretReference,
          approvedScopes: connection.approvedScopes,
          timezone: connection.timezone,
          enabled: connection.enabled,
        })
        .returning();
      return toConnection(row!);
    });
  }
}
