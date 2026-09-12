import type { OrganizationRole } from '@samvardiq/identity-access';

import { extractBearerToken, type RequestBoundaryDependencies } from './requestBoundary.js';

/**
 * IDENTITY-W8 — pre-organization discovery (section 7/10). Deliberately
 * NOT built from `authenticateRequest`: that function requires a
 * `requestedOrganizationId` up front and returns a
 * `TrustedOrganizationContext` — exactly the "organization authority"
 * this endpoint must never produce (section 7: "authenticated internal
 * identity ≠ trusted organization authority"). This is a narrower
 * sibling boundary: verify the credential, resolve identity, list
 * eligible organizations — nothing more.
 */
export interface OrganizationSummary {
  organizationId: string;
  name: string;
  role: OrganizationRole;
}

export interface DiscoveryRequest {
  authorizationHeader: string | string[] | undefined;
}

/**
 * Never throws for "no organizations" reasons — an unprovisioned,
 * suspended, or revoked identity, or a genuinely membership-less one, all
 * produce the identical empty array (see
 * `AuthorizationService.listEligibleOrganizations`'s own doc comment for
 * the full non-enumeration reasoning). Only credential-verification
 * failures (missing/invalid/expired token, provider unavailable) still
 * throw, to be mapped by the existing `classifyError` exactly as every
 * other route already does (401/503) — this endpoint does not invent a
 * new error-mapping story, only a new non-throwing success contract for
 * the identity-state branch.
 *
 * A membership pointing at an organization that no longer exists in
 * data-foundation (the same orphan-membership case W4 already handles
 * for `resolveOrganizationAccess`) is silently skipped here too — never
 * surfaced as a partial/broken entry in the selector.
 */
export async function handleListMyOrganizationsRequest(
  deps: RequestBoundaryDependencies,
  request: DiscoveryRequest,
): Promise<OrganizationSummary[]> {
  const rawToken = extractBearerToken(request.authorizationHeader);
  const principal = await deps.identityProvider.verifyCredential({ rawToken });

  const eligible = await deps.authz.listEligibleOrganizations(principal);

  const summaries: OrganizationSummary[] = [];
  for (const { organizationId, role } of eligible) {
    const organization = await deps.organizations.get(organizationId);
    if (!organization) continue;
    summaries.push({ organizationId, name: organization.name, role });
  }
  return summaries;
}
