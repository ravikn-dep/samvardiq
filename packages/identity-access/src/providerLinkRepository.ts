import { DuplicateProviderLinkError } from './errors.js';
import type { IdentityProviderLink } from './types.js';

export interface CreateProviderLinkInput {
  identityId: string;
  provider: string;
  providerSubject: string;
}

/** Platform-global. `(provider, providerSubject)` is the required-unique lookup key — see types.ts. */
export interface IdentityProviderLinkRepository {
  create(input: CreateProviderLinkInput): Promise<IdentityProviderLink>;
  findIdentityId(provider: string, providerSubject: string): Promise<string | undefined>;
}

export class InMemoryIdentityProviderLinkRepository implements IdentityProviderLinkRepository {
  private readonly links = new Map<string, IdentityProviderLink>();

  private key(provider: string, providerSubject: string): string {
    return `${provider}::${providerSubject}`;
  }

  async create(input: CreateProviderLinkInput): Promise<IdentityProviderLink> {
    const key = this.key(input.provider, input.providerSubject);
    if (this.links.has(key)) {
      throw new DuplicateProviderLinkError(input.provider, input.providerSubject);
    }
    const link: IdentityProviderLink = {
      identityId: input.identityId,
      provider: input.provider,
      providerSubject: input.providerSubject,
      createdAt: new Date().toISOString(),
    };
    this.links.set(key, link);
    return { ...link };
  }

  async findIdentityId(provider: string, providerSubject: string): Promise<string | undefined> {
    return this.links.get(this.key(provider, providerSubject))?.identityId;
  }
}
