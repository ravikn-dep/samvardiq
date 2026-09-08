import { DuplicateEntityError } from './errors.js';
import type { Identity, IdentityStatus, PrincipalType } from './types.js';

export interface CreateIdentityInput {
  identityId: string;
  principalType: PrincipalType;
  displayName: string;
  status?: IdentityStatus;
}

/** Platform-global — no organizationId parameter anywhere; identity is not organization-scoped. */
export interface IdentityRepository {
  create(input: CreateIdentityInput): Promise<Identity>;
  get(identityId: string): Promise<Identity | undefined>;
  updateStatus(identityId: string, status: IdentityStatus): Promise<void>;
}

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly identities = new Map<string, Identity>();

  async create(input: CreateIdentityInput): Promise<Identity> {
    if (this.identities.has(input.identityId)) {
      throw new DuplicateEntityError('Identity', input.identityId);
    }
    const now = new Date().toISOString();
    const identity: Identity = {
      identityId: input.identityId,
      principalType: input.principalType,
      displayName: input.displayName,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.identities.set(identity.identityId, identity);
    return { ...identity };
  }

  async get(identityId: string): Promise<Identity | undefined> {
    const identity = this.identities.get(identityId);
    return identity ? { ...identity } : undefined;
  }

  async updateStatus(identityId: string, status: IdentityStatus): Promise<void> {
    const identity = this.identities.get(identityId);
    if (!identity) return;
    this.identities.set(identityId, { ...identity, status, updatedAt: new Date().toISOString() });
  }
}
