import type { ClinicCmsConnection } from './types.js';

/**
 * Organization-scoped by signature (section 8), matching the same
 * discipline `data-foundation`/`identity-access` repositories already
 * establish: every method takes `organizationId` explicitly, never a bare
 * `connectionId` lookup that could cross organizations.
 */
export interface ClinicCmsConnectionRepository {
  /** The single enabled connection for this organization, or `null` if none exists or none is enabled. */
  getEnabledForOrganization(organizationId: string): Promise<ClinicCmsConnection | null>;
  create(connection: ClinicCmsConnection): Promise<ClinicCmsConnection>;
}

export class InMemoryClinicCmsConnectionRepository implements ClinicCmsConnectionRepository {
  private readonly connections = new Map<string, ClinicCmsConnection>();

  async getEnabledForOrganization(organizationId: string): Promise<ClinicCmsConnection | null> {
    for (const connection of this.connections.values()) {
      if (connection.organizationId === organizationId && connection.enabled) return { ...connection };
    }
    return null;
  }

  async create(connection: ClinicCmsConnection): Promise<ClinicCmsConnection> {
    const key = `${connection.organizationId}::${connection.connectionId}`;
    if (this.connections.has(key)) {
      throw new Error(`Duplicate connection: ${key}`);
    }
    this.connections.set(key, { ...connection });
    return { ...connection };
  }
}
