import { eq } from 'drizzle-orm';

import { DuplicateEntityError } from '../errors.js';
import type { CreateIdentityInput, IdentityRepository } from '../identityRepository.js';
import type { Identity, IdentityStatus, PrincipalType } from '../types.js';
import { pgErrorCode, type Database } from './client.js';
import { identities } from './schema.js';

/** Platform-global, no RLS — plain queries against `db`, no transaction/context wrapper needed. */
export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateIdentityInput): Promise<Identity> {
    try {
      const [row] = await this.db
        .insert(identities)
        .values({
          identityId: input.identityId,
          principalType: input.principalType,
          displayName: input.displayName,
          status: input.status ?? 'active',
        })
        .returning();
      return toIdentity(row!);
    } catch (error) {
      if (pgErrorCode(error) === '23505') throw new DuplicateEntityError('Identity', input.identityId);
      throw error;
    }
  }

  async get(identityId: string): Promise<Identity | undefined> {
    const [row] = await this.db.select().from(identities).where(eq(identities.identityId, identityId));
    return row ? toIdentity(row) : undefined;
  }

  async updateStatus(identityId: string, status: IdentityStatus): Promise<void> {
    await this.db.update(identities).set({ status, updatedAt: new Date() }).where(eq(identities.identityId, identityId));
  }
}

function toIdentity(row: typeof identities.$inferSelect): Identity {
  return {
    identityId: row.identityId,
    principalType: row.principalType as PrincipalType,
    displayName: row.displayName,
    status: row.status as IdentityStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
