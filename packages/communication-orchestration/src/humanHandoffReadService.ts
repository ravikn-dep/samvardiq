import { authenticateRequest, type IncomingRequest, type RequestBoundaryDependencies } from '@samvardiq/application-services';
import type { TrustedOrganizationContext } from '@samvardiq/identity-access';

import type { ConversationRepository } from './conversationRepository.js';
import { HumanHandoffAccessForbiddenError } from './errors.js';
import type { Conversation, HumanHandoffSummary } from './types.js';

/**
 * CLINIC-W2C, section 8. The ONE policy boundary for "may this trusted
 * actor read the human handoff inbox?" — mirrors identity-access's own
 * `canAdministerMembership()` precedent exactly (a single named function,
 * never an inline `if` scattered at each call site). Unlike membership
 * administration (OWNER only — "managing the organization itself"),
 * reading an already-scoped operational inbox is a plain read: every
 * existing read route in this codebase (goals, clinic consultants/slots)
 * already grants access to ANY active membership role, with no
 * role-specific restriction — VIEWER is explicitly "read-only" per
 * ADR-IDENTITY-001's own Role Model, not "no-access." This function
 * therefore only enforces `principalType === 'human'`; `role` is
 * intentionally not read at all, and `approverRole` is never consulted
 * (ARCH-016's separation applies here exactly as it does to membership
 * administration).
 */
export function canReadHumanHandoffInbox(actor: TrustedOrganizationContext): boolean {
  return actor.principalType === 'human';
}

function toHumanHandoffSummary(conversation: Conversation): HumanHandoffSummary {
  return {
    conversationId: conversation.conversationId,
    channelId: conversation.channelId,
    state: conversation.state,
    handoffTrigger: conversation.handoffTrigger,
    handoffAt: conversation.handoffAt,
    bookingState: conversation.bookingState,
    preferredLanguage: conversation.preferredLanguage,
    externalPatientId: conversation.externalPatientId,
    activeEnquiryId: conversation.activeEnquiryId,
    activeAppointmentId: conversation.activeAppointmentId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export interface HumanHandoffReadDependencies extends RequestBoundaryDependencies {
  conversations: ConversationRepository;
}

export interface ListHumanHandoffsRequest extends IncomingRequest {
  limit: number;
  cursor?: string;
}

export interface HumanHandoffPage {
  items: HumanHandoffSummary[];
  nextCursor?: string;
}

/**
 * The entire W2C application-service boundary (section 9): authenticate ->
 * enforce human-only access -> query the organization-scoped repository ->
 * return minimized DTOs. Never mutates communication state, never calls
 * the CMS, never sends outbound WhatsApp — this is READ-FIRST, exactly as
 * section 14 requires.
 */
export async function handleListHumanHandoffsRequest(deps: HumanHandoffReadDependencies, request: ListHumanHandoffsRequest): Promise<HumanHandoffPage> {
  const context = await authenticateRequest(deps, request);
  if (!canReadHumanHandoffInbox(context)) {
    throw new HumanHandoffAccessForbiddenError();
  }
  const page = await deps.conversations.listHumanHandoffs(context.organizationId, { limit: request.limit, cursor: request.cursor });
  return { items: page.items.map(toHumanHandoffSummary), nextCursor: page.nextCursor };
}
