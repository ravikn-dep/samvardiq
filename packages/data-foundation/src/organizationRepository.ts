import { DuplicateEntityError } from './errors.js';
import type { Organization, OrganizationStatus } from './types.js';

/** The organization is the isolation root — every other repository is keyed off it. */
export interface CreateOrganizationInput {
  organizationId: string;
  organizationType: string;
  name: string;
  status?: OrganizationStatus;
}

/** Async (DATA-W3): a Postgres-backed implementation is inherently network-bound. */
export interface OrganizationRepository {
  create(input: CreateOrganizationInput): Promise<Organization>;
  get(organizationId: string): Promise<Organization | undefined>;
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly organizations = new Map<string, Organization>();

  async create(input: CreateOrganizationInput): Promise<Organization> {
    if (this.organizations.has(input.organizationId)) {
      throw new DuplicateEntityError('Organization', input.organizationId);
    }
    const now = new Date().toISOString();
    const organization: Organization = {
      organizationId: input.organizationId,
      organizationType: input.organizationType,
      name: input.name,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.set(organization.organizationId, organization);
    return { ...organization };
  }

  async get(organizationId: string): Promise<Organization | undefined> {
    const organization = this.organizations.get(organizationId);
    return organization ? { ...organization } : undefined;
  }
}
