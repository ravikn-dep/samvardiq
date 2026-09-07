import { eq } from 'drizzle-orm';

import { DuplicateEntityError } from '../errors.js';
import type { CreateOrganizationInput, OrganizationRepository } from '../organizationRepository.js';
import type { Organization, OrganizationStatus } from '../types.js';
import { pgErrorCode, withOrganizationContext, type Database } from './client.js';
import { organizations } from './schema.js';

export class PostgresOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateOrganizationInput): Promise<Organization> {
    return withOrganizationContext(this.db, input.organizationId, async (tx) => {
      try {
        const [row] = await tx
          .insert(organizations)
          .values({
            organizationId: input.organizationId,
            organizationType: input.organizationType,
            name: input.name,
            status: input.status ?? 'active',
          })
          .returning();
        return toOrganization(row!);
      } catch (error) {
        if (pgErrorCode(error) === '23505') throw new DuplicateEntityError('Organization', input.organizationId);
        throw error;
      }
    });
  }

  async get(organizationId: string): Promise<Organization | undefined> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const [row] = await tx.select().from(organizations).where(eq(organizations.organizationId, organizationId));
      return row ? toOrganization(row) : undefined;
    });
  }
}

function toOrganization(row: typeof organizations.$inferSelect): Organization {
  return {
    organizationId: row.organizationId,
    organizationType: row.organizationType,
    name: row.name,
    status: row.status as OrganizationStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
