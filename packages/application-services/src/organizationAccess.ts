import type { AuthorizationService, TrustedOrganizationContext, VerifiedPrincipal } from '@samvardiq/identity-access';
import { UnknownOrganizationError } from '@samvardiq/identity-access';
import type { OrganizationRepository } from '@samvardiq/data-foundation';

/**
 * Closes the orphan-organization gap ADR-IDENTITY-001 deliberately left
 * open (identity-access's `organization_memberships.organization_id` has
 * no physical FK into data-foundation's `organizations` table — see that
 * package's types.ts package-boundary note, and errors.ts's
 * `UnknownOrganizationError`, which was reserved for exactly this future
 * orchestration layer).
 *
 * Sequence (matches ADR's own diagram plus this session's brief, section
 * 21): requestedOrganizationId -> organization existence resolved against
 * data-foundation's OWN table -> only then membership authorization via
 * the real, unmodified AuthorizationService. A membership row pointing at
 * an organization that does not exist in data-foundation (e.g. because it
 * was never created, or a future org-deletion flow forgot to cascade a
 * membership revoke) can never become a valid TrustedOrganizationContext,
 * regardless of what the membership row itself says.
 *
 * The existence lookup uses `requestedOrganizationId` (untrusted) as the
 * RLS scope for `organizations.get()` — the same "bootstrap path" pattern
 * IDENTITY-W2/W3 already proved is not a bypass (RLS only restricts which
 * row is visible for that scope; the authorization decision is made by
 * this code inspecting whether a row came back, not by the act of
 * scoping the query itself).
 */
export async function resolveOrganizationAccess(
  authz: AuthorizationService,
  organizations: OrganizationRepository,
  principal: VerifiedPrincipal,
  requestedOrganizationId: string,
): Promise<TrustedOrganizationContext> {
  const organization = await organizations.get(requestedOrganizationId);
  if (!organization) {
    throw new UnknownOrganizationError(requestedOrganizationId);
  }
  return authz.resolveTrustedContext({ principal, requestedOrganizationId });
}
