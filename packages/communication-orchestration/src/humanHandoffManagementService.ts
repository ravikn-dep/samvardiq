import { authenticateRequest, type IncomingRequest, type RequestBoundaryDependencies } from '@samvardiq/application-services';
import type { TrustedOrganizationContext } from '@samvardiq/identity-access';

import type { ConversationRepository } from './conversationRepository.js';
import { HumanHandoffAccessForbiddenError, HumanHandoffConflictError, HumanHandoffNotFoundError } from './errors.js';
import { toHumanHandoffSummary } from './humanHandoffReadService.js';
import type { HandoffResolutionOutcome, HumanHandoffSummary } from './types.js';

/**
 * CLINIC-W2D: the ONE policy boundary for "may this trusted actor claim or
 * resolve human handoffs?" — same single-named-function precedent as
 * `canAdministerMembership` and `canReadHumanHandoffInbox`. Claiming and
 * resolving a patient handoff is day-to-day operation, which ADR-IDENTITY-001's
 * Role Model gives to OWNER and MEMBER; VIEWER is read-only and keeps only the
 * W2C read path. A service principal never manages a human handoff.
 * `approverRole` is never consulted (ARCH-016).
 */
export function canManageHumanHandoff(actor: TrustedOrganizationContext): boolean {
  return actor.principalType === 'human' && (actor.role === 'OWNER' || actor.role === 'MEMBER');
}

export interface HumanHandoffManagementDependencies extends RequestBoundaryDependencies {
  conversations: ConversationRepository;
}

export interface HumanHandoffActionRequest extends IncomingRequest {
  conversationId: string;
}

export interface ResolveHumanHandoffRequest extends HumanHandoffActionRequest {
  outcome: HandoffResolutionOutcome;
}

async function authorize(deps: HumanHandoffManagementDependencies, request: IncomingRequest): Promise<TrustedOrganizationContext> {
  const context = await authenticateRequest(deps, request);
  if (!canManageHumanHandoff(context)) throw new HumanHandoffAccessForbiddenError();
  return context;
}

/** Authenticate -> human OWNER/MEMBER -> atomic claim in the caller's own organization. A retry by the current owner succeeds without a second audit event. */
export async function handleClaimHumanHandoffRequest(deps: HumanHandoffManagementDependencies, request: HumanHandoffActionRequest): Promise<HumanHandoffSummary> {
  const context = await authorize(deps, request);
  const result = await deps.conversations.claimHumanHandoff(context.organizationId, request.conversationId, context.identityId);
  if (!('conversation' in result)) throw result.kind === 'NOT_FOUND' ? new HumanHandoffNotFoundError() : new HumanHandoffConflictError();
  return toHumanHandoffSummary(result.conversation);
}

/** Authenticate -> human OWNER/MEMBER -> only the current owner resolves (no override, no transfer in W2D). */
export async function handleResolveHumanHandoffRequest(
  deps: HumanHandoffManagementDependencies,
  request: ResolveHumanHandoffRequest,
): Promise<{ conversationId: string; state: string; outcome: HandoffResolutionOutcome }> {
  const context = await authorize(deps, request);
  const result = await deps.conversations.resolveHumanHandoff(context.organizationId, request.conversationId, context.identityId, request.outcome);
  if (!('conversation' in result)) throw result.kind === 'NOT_FOUND' ? new HumanHandoffNotFoundError() : new HumanHandoffConflictError();
  return { conversationId: result.conversation.conversationId, state: result.conversation.state, outcome: request.outcome };
}
