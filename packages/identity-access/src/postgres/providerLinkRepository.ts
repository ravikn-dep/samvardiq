import { and, eq } from 'drizzle-orm';

import { DuplicateProviderLinkError, UnknownIdentityError } from '../errors.js';
import type { CreateProviderLinkInput, IdentityProviderLinkRepository } from '../providerLinkRepository.js';
import type { IdentityProviderLink } from '../types.js';
import { pgErrorCode, type Database } from './client.js';
import { identityProviderLinks } from './schema.js';

/** Platform-global, no RLS. */
export class PostgresIdentityProviderLinkRepository implements IdentityProviderLinkRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateProviderLinkInput): Promise<IdentityProviderLink> {
    try {
      const [row] = await this.db
        .insert(identityProviderLinks)
        .values({ identityId: input.identityId, provider: input.provider, providerSubject: input.providerSubject })
        .returning();
      return toLink(row!);
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === '23505') throw new DuplicateProviderLinkError(input.provider, input.providerSubject);
      if (code === '23503') throw new UnknownIdentityError(input.identityId);
      throw error;
    }
  }

  async findIdentityId(provider: string, providerSubject: string): Promise<string | undefined> {
    const [row] = await this.db
      .select()
      .from(identityProviderLinks)
      .where(and(eq(identityProviderLinks.provider, provider), eq(identityProviderLinks.providerSubject, providerSubject)));
    return row?.identityId;
  }
}

function toLink(row: typeof identityProviderLinks.$inferSelect): IdentityProviderLink {
  return {
    identityId: row.identityId,
    provider: row.provider,
    providerSubject: row.providerSubject,
    createdAt: row.createdAt.toISOString(),
  };
}
