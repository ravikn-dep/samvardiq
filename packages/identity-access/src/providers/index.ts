/**
 * Deliberately NOT re-exported from the package's main index.ts —
 * provider-specific implementations are imported explicitly from this
 * subpath, keeping the top-level barrel a purely provider-neutral
 * surface (IdentityProviderAdapter, VerifiedPrincipal, AuthorizationService).
 */
export * from './supabaseIdentityProviderAdapter.js';
