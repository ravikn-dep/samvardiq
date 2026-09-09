import type { TrustedOrganizationContext } from '@samvardiq/identity-access';
import type { Goal, GoalRepository } from '@samvardiq/data-foundation';

/**
 * The first protected vertical slice (section 7/18). Goal listing was
 * chosen over Organization read (the existence check in
 * organizationAccess.ts already exercises that path directly, so using
 * it again as the "protected operation" would blur the two concerns) and
 * over Recommendation/Approval read (those carry governance semantics
 * this session explicitly should not exercise — section 26). A goal
 * (title/description/status/ownerExecutive, see data-foundation's
 * types.ts) is plain business data with no clinical/patient content.
 *
 * Section 25: reading an organization's own goals is safe for every
 * active membership role (OWNER/MEMBER/VIEWER) — no additional role
 * check is added here. `context.approverRole` is never read by this
 * service (section 26/AJ): organization access and approval authority
 * are deliberately separate.
 *
 * Section 8: accepts `TrustedOrganizationContext`, not a raw
 * `organizationId` — `context.organizationId` is extracted internally,
 * the only place a raw string reaches the repository call (section
 * 19/AB).
 *
 * Known limitation, stated precisely rather than overclaimed (same
 * structural-typing caveat IDENTITY-W3 already documented for
 * `VerifiedPrincipal`): `TrustedOrganizationContext` is a plain
 * TypeScript interface, so nothing at the type-system level stops
 * in-process code from hand-constructing an object with this shape and
 * calling `listGoals` directly, bypassing `resolveOrganizationAccess`.
 * The real boundary is procedural, not a runtime brand: the ONLY
 * production code path that constructs a real
 * `TrustedOrganizationContext` remains `AuthorizationService.resolveTrustedContext`
 * (unmodified by this session), and this package never calls it any
 * other way (see `organizationAccess.ts` / `requestBoundary.ts`).
 */
export class GoalReadService {
  constructor(private readonly goals: GoalRepository) {}

  async listGoals(context: TrustedOrganizationContext): Promise<Goal[]> {
    return this.goals.listByOrganization(context.organizationId);
  }
}
