import type { AuthorizationService, IdentityProviderAdapter, TrustedOrganizationContext } from '@samvardiq/identity-access';
import { InvalidCredentialError } from '@samvardiq/identity-access';
import type { OrganizationRepository } from '@samvardiq/data-foundation';

import { resolveOrganizationAccess } from './organizationAccess.js';

/**
 * Section 11 transport choice: the requested organization travels as an
 * explicit header, named `requestedOrganizationId` (not
 * `authorizedOrganizationId`) everywhere in this codebase to keep it
 * visibly untrusted until `resolveOrganizationAccess` proves otherwise.
 * A header (rather than a route parameter) was chosen because no router
 * exists yet to own route-parameter parsing — see the package doc
 * comment on why no concrete HTTP framework was introduced this session.
 * Convention: `X-Samvardiq-Organization-Id`.
 */
export const REQUESTED_ORGANIZATION_HEADER = 'x-samvardiq-organization-id';

/**
 * CSRF (section 22): a Bearer token is never attached automatically by a
 * browser the way a cookie is — a malicious page cannot make the
 * victim's browser silently send it. Classical cookie-based CSRF
 * therefore does not apply to this transport. What DOES remain a real
 * concern, and is explicitly NOT solved here: XSS on whatever frontend
 * stores the token (token theft), and CORS misconfiguration once an
 * actual HTTP server exists (section 23) — a permissive
 * `Access-Control-Allow-Origin: *` must never be paired with
 * credentialed requests; that configuration is deferred to whichever
 * concrete HTTP framework/deployment is chosen next, not decided here.
 *
 * Replay (section 24): a stolen-but-unexpired bearer token IS replayable
 * by whoever holds it — this is not prevented by anything in this
 * package. Compensating, already-real controls: token expiration
 * (provider-enforced), TLS in transit (a deployment requirement, not
 * something this package can enforce), and — the control that actually
 * matters for organization access — every resolution re-checks
 * Samvardiq's own identity/membership state fresh (see
 * organizationAccess.ts / AuthorizationService), so a replayed token's
 * blast radius is bounded by the victim's *current* membership, not a
 * cached grant. No nonce/replay-cache infrastructure is built; it is not
 * justified for this session's scope.
 */
export function extractBearerToken(authorizationHeader: string | string[] | undefined): string {
  if (authorizationHeader === undefined) {
    throw new InvalidCredentialError('missing Authorization header');
  }
  if (Array.isArray(authorizationHeader)) {
    if (authorizationHeader.length !== 1) {
      throw new InvalidCredentialError('multiple ambiguous Authorization headers');
    }
    return extractBearerToken(authorizationHeader[0]);
  }

  const parts = authorizationHeader.trim().split(/\s+/);
  if (parts.length !== 2) {
    throw new InvalidCredentialError('malformed Authorization header');
  }
  const [scheme, token] = parts;
  if (scheme!.toLowerCase() !== 'bearer') {
    throw new InvalidCredentialError('unsupported Authorization scheme');
  }
  if (!token) {
    throw new InvalidCredentialError('empty bearer token');
  }
  return token;
}

export function extractRequestedOrganizationId(headerValue: string | string[] | undefined): string {
  if (headerValue === undefined) {
    throw new InvalidCredentialError(`missing ${REQUESTED_ORGANIZATION_HEADER} header`);
  }
  if (Array.isArray(headerValue)) {
    if (headerValue.length !== 1) {
      throw new InvalidCredentialError(`multiple ambiguous ${REQUESTED_ORGANIZATION_HEADER} headers`);
    }
    return extractRequestedOrganizationId(headerValue[0]);
  }
  const value = headerValue.trim();
  if (!value) {
    throw new InvalidCredentialError(`empty ${REQUESTED_ORGANIZATION_HEADER} header`);
  }
  return value;
}

export interface RequestBoundaryDependencies {
  identityProvider: IdentityProviderAdapter;
  authz: AuthorizationService;
  organizations: OrganizationRepository;
}

export interface IncomingRequest {
  authorizationHeader: string | string[] | undefined;
  requestedOrganizationId: string | string[] | undefined;
}

/**
 * The entire request authentication boundary (section 9). Framework-
 * neutral by construction: it takes plain header-shaped values in and
 * returns a `TrustedOrganizationContext` or throws — no assumption about
 * Express/Fastify/Hono/etc. request/response objects. A future HTTP
 * framework's middleware becomes a thin adapter that extracts these two
 * header values and calls this function; it does not reimplement any of
 * the logic here.
 *
 * Never determines business permissions, never assigns roles, never
 * constructs TrustedOrganizationContext directly, never bypasses
 * AuthorizationService — it only (1) extracts an untrusted credential,
 * (2) hands it to the identity provider adapter for real verification,
 * and (3) hands the resulting VerifiedPrincipal plus the still-untrusted
 * requested organization id to `resolveOrganizationAccess`.
 */
export async function authenticateRequest(
  deps: RequestBoundaryDependencies,
  request: IncomingRequest,
): Promise<TrustedOrganizationContext> {
  const rawToken = extractBearerToken(request.authorizationHeader);
  const requestedOrganizationId = extractRequestedOrganizationId(request.requestedOrganizationId);

  const principal = await deps.identityProvider.verifyCredential({ rawToken });

  return resolveOrganizationAccess(deps.authz, deps.organizations, principal, requestedOrganizationId);
}
