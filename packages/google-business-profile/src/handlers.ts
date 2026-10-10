import { authenticateRequest, type IncomingRequest, type RequestBoundaryDependencies } from '@samvardiq/application-services';
import type { TrustedOrganizationContext } from '@samvardiq/identity-access';

import type { GbpConnectionService, GbpDisconnectResult, GbpStatus, GbpVerifyResult } from './connectionService.js';
import { GbpNotConfiguredError } from './errors.js';

export type GbpRouteDependencies = RequestBoundaryDependencies & {
  /** null when the deployment has no Google OAuth client configured (routes then answer 503 after authentication). */
  gbp: GbpConnectionService | null;
};

/**
 * Thin request-boundary handlers (same shape as membershipAdministrationHandlers.ts):
 * request → unmodified `authenticateRequest` (fresh Supabase verification,
 * identity, ACTIVE membership → TrustedOrganizationContext) → the service, which
 * enforces human OWNER. The organization is the route's `:organizationId`
 * only — never anything returned by Google and never the OAuth state (G4).
 */
async function authorized(deps: GbpRouteDependencies, request: IncomingRequest): Promise<{ context: TrustedOrganizationContext; gbp: GbpConnectionService }> {
  const context = await authenticateRequest(deps, request);
  if (!deps.gbp) throw new GbpNotConfiguredError();
  return { context, gbp: deps.gbp };
}

export async function handleGbpStatusRequest(deps: GbpRouteDependencies, request: IncomingRequest): Promise<GbpStatus> {
  const { context, gbp } = await authorized(deps, request);
  return gbp.status(context);
}

export async function handleGbpBeginAuthorizationRequest(deps: GbpRouteDependencies, request: IncomingRequest, redirectUri: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const { context, gbp } = await authorized(deps, request);
  return gbp.beginAuthorization(context, redirectUri);
}

export async function handleGbpCompleteAuthorizationRequest(deps: GbpRouteDependencies, request: IncomingRequest, input: { state: string; code?: string; error?: string }): Promise<GbpStatus> {
  const { context, gbp } = await authorized(deps, request);
  return gbp.completeAuthorization(context, input);
}

export async function handleGbpBindRequest(deps: GbpRouteDependencies, request: IncomingRequest, input: { locationNames: string[]; confirm: boolean }): Promise<GbpStatus> {
  const { context, gbp } = await authorized(deps, request);
  return gbp.bind(context, input);
}

export async function handleGbpUnbindRequest(deps: GbpRouteDependencies, request: IncomingRequest, locationName: string): Promise<GbpStatus> {
  const { context, gbp } = await authorized(deps, request);
  return gbp.unbind(context, locationName);
}

export async function handleGbpRefreshDiscoveryRequest(deps: GbpRouteDependencies, request: IncomingRequest): Promise<GbpStatus> {
  const { context, gbp } = await authorized(deps, request);
  return gbp.refreshDiscovery(context);
}

export async function handleGbpVerifyRequest(deps: GbpRouteDependencies, request: IncomingRequest): Promise<GbpVerifyResult> {
  const { context, gbp } = await authorized(deps, request);
  return gbp.verifyConnection(context);
}

export async function handleGbpDisconnectRequest(deps: GbpRouteDependencies, request: IncomingRequest, input: { revokeGoogleAccess: boolean }): Promise<GbpDisconnectResult> {
  const { context, gbp } = await authorized(deps, request);
  return gbp.disconnect(context, input);
}
