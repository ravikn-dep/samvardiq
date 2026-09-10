import type { TrustedOrganizationContext } from './types.js';

/**
 * IDENTITY-W7 — the ONE explicit policy boundary for "may this trusted
 * actor administer organization membership?" (section 14: centralized,
 * not repeated as `if (role === 'OWNER')` scattered across every
 * operation). Every `PostgresMembershipAdministrationService` method
 * calls this first, before touching the database.
 *
 * Policy (see the session report's "Membership Administration Authority"
 * section for why this reading of ADR-IDENTITY-001 did not require a
 * Founder policy-gate stop): OWNER "can manage the organization itself"
 * per ADR-IDENTITY-001's Role Model — membership administration is a
 * direct instance of managing the organization. MEMBER ("day-to-day
 * operation") and VIEWER ("read-only") carry no such authority.
 *
 * `approverRole` (Recommendation Approval Governance) is NEVER consulted
 * here and never will be — organization-membership administration and
 * approval authority are deliberately separate systems (ARCH-016), and
 * this function's signature (it only reads `role`/`principalType`) makes
 * that separation a structural fact, not just a convention someone could
 * accidentally violate by adding one more `if`.
 *
 * `principalType` must be `'human'` — a service principal must never
 * administer human organizational membership, the same "AI/service can
 * never obtain human-only authority" spirit ADR-IDENTITY-001 already
 * applies to approval authority (`AiSelfApprovalError`), extended here to
 * membership administration for the identical reason.
 */
export function canAdministerMembership(actor: TrustedOrganizationContext): boolean {
  return actor.principalType === 'human' && actor.role === 'OWNER';
}
