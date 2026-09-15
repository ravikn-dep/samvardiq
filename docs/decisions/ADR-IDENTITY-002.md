# ADR-IDENTITY-002 — Non-Human (Service Principal) Authority for Automated Communication Workflows

**Status:** APPROVED — W2-ARCH final approval review, corrections applied (see "Threat Model" and the corrected "Narrow Capability" section below — an earlier draft's proposed `assertHumanPrincipal()` guard was found redundant against already-shipped IDENTITY-W7 code and removed). Recorded as `ARCH-019` in `docs/11_Decisions.md` (verified next-available identifier — `ARCH-018` is the highest currently recorded).

**Session:** CLINIC-W2 (Founder Decision 4: "PRINCIPLE APPROVED / IMPLEMENTATION ARCHITECTURE: REQUIRES CONTROLLED ADR").

**Depends on:** `ADR-IDENTITY-001.md` (`ARCH-016`) — this ADR implements, and does not amend or reopen, that ADR's already-approved `principalType: 'human' | 'service'` distinction and its "Service / Agent Identity" section, which explicitly reserved this ground ("This directly prepares the ground... for a future Clinic CMS connector... No credential material, rotation mechanism, or actual connector is built or specified here"). Also depends on `docs/integrations/CLINIC_CMS_CONNECTOR_CONTRACT.md` (CLINIC-W1B) and `docs/integrations/CLINIC_W2_COMMUNICATION_ARCHITECTURE.md` (architecture approved alongside this ADR).

---

## Context

CLINIC-W2's `AppointmentOrchestrator` must call the existing, unmodified `application-services/clinicOperationsHandler.ts` functions to search/register patients and create enquiries/appointments in response to a WhatsApp conversation. Every one of those functions currently authenticates its caller via `authenticateRequest`, which requires a Bearer-token-carrying human Supabase session. A WhatsApp webhook delivery has no such session — it is an HTTP POST from Meta's servers, authenticated only by an HMAC signature over the payload.

The Founder's approved principle (Decision 4) is explicit: provider authentication proves an event came from the configured provider, nothing more; organization authority must still be resolved server-side; the executing principal must be an explicit, organization-scoped, narrowly-capable **non-human** identity, distinct from human identities, never carrying approval authority; and `TrustedOrganizationContext` must never be forged or populated with a synthetic **human** identity merely to reuse human-only handlers.

This ADR proposes the smallest mechanism that satisfies all of that using what `ADR-IDENTITY-001` already built and tested.

## What Already Exists (Verified Against Source, Not Assumed)

- `Identity.principalType: 'human' | 'service'` — already a real, enforced column (`identities_principal_type_check`).
- `TrustedOrganizationContext.principalType` — already a field, already populated from the resolved identity, not the caller.
- `AuthorizationService.resolveTrustedContext()` — already provider-agnostic (`VerifiedPrincipal.provider`/`providerSubject` are opaque strings; nothing in this function assumes Supabase or a JWT). Already independently re-derives membership from a live database read on every call, per `ADR-IDENTITY-001`'s "Session & Membership Freshness Strategy."
- **Already-existing, already-tested defense-in-depth**: `resolveTrustedContext` strips `approverRole` to `undefined` unless `identity.principalType === 'human'` — a service principal cannot carry human approval authority through this context even if a membership row were misconfigured with one. This is not new; it is read directly from `packages/identity-access/src/authorizationService.ts:73–77` and already covered by an existing test.
- `IdentityRepository.create()`, `IdentityProviderLinkRepository.create()`, `MembershipRepository.create()` — already exist, already used throughout the test suites, sufficient to provision a service identity with no new repository code.
- `PostgresMembershipAdministrationService` (`suspendMembership`/`revokeMembership`) — already exists, already sufficient to *disable* a service principal's access using the exact same lifecycle machinery as a human membership.

**Conclusion: no new table, no new authorization mechanism, and no change to `AuthorizationService` are required.** The originally-sketched `ServicePrincipalScope` table in `ADR-IDENTITY-001` is **not proposed here** — see "Candidates" below for why the existing `organization_memberships` table is sufficient and simpler.

## Requirements (Restated From the Approved Principle)

1. Provider authentication (Meta's webhook HMAC signature) must be verified before anything else happens.
2. The verified event's own data (never anything patient-supplied) must resolve to exactly one Samvardiq organization.
3. The principal that executes the resulting clinic-connector calls must be explicit, non-human, organization-scoped, and structurally incapable of carrying human approval authority.
4. That principal's capability must be narrow — not "anything a human OWNER/MEMBER could do in this organization."
5. `TrustedOrganizationContext` must be produced only by the same real, tested resolution path every other principal already goes through — never hand-constructed.
6. The mechanism must be revocable using existing lifecycle tools, without inventing a new one.

## Candidates

### A. Reuse `organization_memberships` directly for service identities (proposed)

A service identity (`principalType: 'service'`) gets an ordinary `organization_memberships` row — `role: 'MEMBER'`, `approverRole: null`, `status: 'ACTIVE'` — exactly like a human membership, provisioned once per clinic/channel through an operator-only path (never through any webhook-triggered code). `AuthorizationService.resolveTrustedContext()` is called completely unmodified.

**Strengths:** zero new schema, zero new authorization code, reuses every existing test's proof of correctness, reuses existing suspend/revoke tooling for kill-switch behavior, reuses the existing `approverRole`-stripping defense-in-depth automatically.
**Weaknesses:** `organization_memberships.role` was designed to express human access levels (OWNER/MEMBER/VIEWER); using `MEMBER` for a service identity is a slight semantic overload — mitigated below by requirement 4's separate, additional restriction.

### B. Build the `ServicePrincipalScope` table `ADR-IDENTITY-001` sketched

A dedicated table (`organizationId`, `servicePrincipalId`, `purpose`, `grantedAt`, `revokedAt`) separate from human memberships.

**Strengths:** semantically cleaner separation of "why does this service identity have access" from human role vocabulary.
**Weaknesses:** requires a new table, a new migration, a new RLS policy, and — critically — a **second** authorization code path (`AuthorizationService` would need a new method, or `resolveTrustedContext` itself would need branching logic to check `ServicePrincipalScope` instead of `organization_memberships` for service principals), which is exactly the kind of "second, competing authorization system" `ADR-HTTP-001`'s framework-boundary rules and this codebase's whole architecture explicitly avoid elsewhere. Not justified by anything W2 actually needs.

**Decision: A.** Candidate B remains available later if a genuinely different access model for service principals emerges (e.g., time-boxed grants, purpose-based multi-scope principals) — nothing in this ADR forecloses building it eventually; it is simply not the smallest correct answer for one WhatsApp channel per organization today.

## The One Genuinely New Piece: A Webhook-Verified Principal Resolver

`IdentityProviderAdapter.verifyCredential(credential: { rawToken: string })` is JWT-shaped and must not be distorted to accept raw webhook bytes packed into a string — that would weaken, not preserve, the existing interface's clarity. Instead, propose a **separate, narrow, parallel resolver** living in the future communication package (not in `identity-access`, which stays provider-agnostic and untouched):

```ts
// proposed — packages/clinic-communication (or similar), NOT identity-access
interface ChannelEventVerifier {
  /** Verifies the Meta webhook HMAC signature over the raw body using the
   *  platform-level App Secret (resolved via the EXISTING ConnectorSecretProvider
   *  abstraction from W1B — no new secret mechanism). Returns a VerifiedPrincipal
   *  ONLY if the signature is valid; throws otherwise. This function IS the
   *  "real, authoritative verification" ADR-IDENTITY-001 already requires of
   *  every VerifiedPrincipal producer — it simply verifies a webhook delivery
   *  instead of a JWT. */
  verifyChannelEvent(rawBody: string, signatureHeader: string): Promise<{ phoneNumberId: string }>;
}

async function resolveChannelServiceContext(
  authz: AuthorizationService,
  channels: CommunicationChannelRepository,   // proposed W2 repository, resolves phone_number_id -> channel
  verifier: ChannelEventVerifier,
  rawBody: string,
  signatureHeader: string,
): Promise<TrustedOrganizationContext> {
  const { phoneNumberId } = await verifier.verifyChannelEvent(rawBody, signatureHeader); // throws on bad signature — Requirement 1
  const channel = await channels.getByExternalChannelId(phoneNumberId);
  if (!channel) throw new UnknownChannelError(phoneNumberId);                            // fail closed — Requirement 2

  const principal: VerifiedPrincipal = {
    provider: 'whatsapp-channel',
    providerSubject: channel.channelId,   // Samvardiq's OWN stable id, never Meta's phone_number_id directly — decouples from Meta-side ID churn
    verifiedAt: new Date().toISOString(),
  };
  // EXISTING, UNMODIFIED function. Independently re-derives membership —
  // the channel lookup above only produces a CANDIDATE organizationId,
  // exactly the same "bootstrap path is not a bypass" reasoning
  // organizationAccess.ts already established for human requests.
  return authz.resolveTrustedContext({ principal, requestedOrganizationId: channel.organizationId }); // Requirements 3, 5
}
```

This mirrors `authenticateRequest`'s exact shape (verify credential → resolve organization access → return `TrustedOrganizationContext`) with different input, and calls the identical downstream function. `identity-access` requires zero changes.

## Narrow Capability (Requirement 4)

Two layers, both cheap:

1. **Structural (primary):** `AppointmentOrchestrator` is bespoke, deterministic code (per the W2 architecture proposal) that only ever passes a resolved service `TrustedOrganizationContext` to the specific clinic-operations handlers it needs (`handleFindClinicPatientsRequest`, `handleRegisterClinicPatientRequest`, `handleCreateClinicEnquiryRequest`, `handleCreateClinicAppointmentRequest`, `handleGetClinicAvailableSlotsRequest`, `handleListClinicConsultantsRequest`). It is never handed to a generic dispatcher, never serialized back to a caller, never reused across requests. This is the same "the real boundary is procedural, not a runtime brand" reasoning `GoalReadService`'s own doc comment already relies on.
2. **Existing guard — verified sufficient, no new code needed (corrected during W2-ARCH final review; an earlier draft of this ADR proposed adding a new `assertHumanPrincipal()` check here, which is redundant).** Every one of the six membership-administration mutations — `createInvitedMembership`, `changeRole`, and all four status transitions (`activateMembership`/`reactivateMembership`/`suspendMembership`/`revokeMembership`, which share one private `transitionStatus` method) — already calls `canAdministerMembership(actor)` **first**, before touching the database (`packages/identity-access/src/postgres/membershipAdministrationService.ts:100,158,208`), and that policy function already requires `actor.principalType === 'human' && actor.role === 'OWNER'` (`packages/identity-access/src/membershipAdministrationPolicy.ts:31`). This is IDENTITY-W7 work, already shipped and already tested — a service principal is already structurally incapable of reaching any membership-administration outcome, with zero new code required. Verified there is no other identity/organization administrative mutation surface anywhere in the repository: `apps/api/src/routes/` contains exactly `clinic.ts`, `goals.ts`, `health.ts`, `me.ts`, `memberships.ts` — `memberships.ts` is the only mutation-capable route file, and it maps 1:1 to these same six already-guarded functions. `data-foundation`'s `OrganizationRepository.create()` has no exposed handler at all.

## Provisioning (Operational, Not Code)

A service identity/link/membership row set is created **once per clinic/channel**, through an operator-only path (a small provisioning script or manual step using the already-existing `identities.create()`/`providerLinks.create()`/`memberships.create()` methods) — never by any webhook-triggered or patient-triggered code. This satisfies Requirement 3's "explicit" language literally: the row must be deliberately created by a person with administrative access, not conjured at request time.

## Kill Switch (Requirement 6)

Disabling WhatsApp automation for an organization = `PostgresMembershipAdministrationService.suspendMembership()` (or `revokeMembership()`) on that org's service identity, or setting `identities.status` to `'suspended'`/`'revoked'` directly — both already-existing, already-tested lifecycle operations. `resolveTrustedContext` already fails closed on either (`InactiveIdentityError`/`MembershipNotActiveError`), so this takes effect on the very next inbound webhook, matching `ADR-IDENTITY-001`'s existing freshness guarantee exactly.

## Security Implications

- A compromised/spoofed webhook payload cannot forge organization authority: it must first pass real HMAC verification (Requirement 1), and even then only names a *candidate* organization via the channel lookup — actual authority still requires a live, ACTIVE membership row for that specific pre-provisioned service identity (Requirement 2/5's "not a bypass" property, identical to the existing human bootstrap-path precedent).
- A compromised WhatsApp channel configuration cannot escalate to human-equivalent access: `approverRole` is stripped by existing code for any non-human principal; membership-administration is additionally hard-guarded (proposed).
- No patient-controlled field ever appears in the `VerifiedPrincipal` or the organization-resolution path — the `providerSubject` is Samvardiq's own internal `channelId`, decided at provisioning time, never derived from the inbound payload's sender field.
- Revocation reuses proven, tested code — no new revocation logic to get wrong.

## Threat Model (added during W2-ARCH final review)

| # | Threat | Result |
|---|---|---|
| A | Forged Meta webhook (invalid/missing signature) | **PREVENTS** — `ChannelEventVerifier` rejects before any principal resolution begins |
| B | Valid webhook naming another organization's `phone_number_id` | **PREVENTS** — organization is derived purely from a server-side channel-table lookup keyed on `phone_number_id`; the payload has no field capable of claiming a different organization |
| C | Valid webhook containing another Samvardiq identity ID | **PREVENTS** — `providerSubject` is always the resolver's own looked-up `channel.channelId`, never read from the payload |
| D | Patient text "act as admin" | **PREVENTS** — patient text never reaches any authority-resolution code; authority is established before content is even inspected |
| E | Patient text requesting membership creation | **PREVENTS** — same as D; and even a routing bug would still hit `canAdministerMembership`'s `principalType === 'human'` check |
| F | Prompt injection requesting arbitrary tool execution | **PREVENTS** — the AI layer is never granted tool-calling capability (Founder Decision 3) |
| G | Disabled communication channel | **FAILS CLOSED** — channel lookup returns no enabled row |
| H | Suspended service identity | **FAILS CLOSED** — existing `InactiveIdentityError`, unmodified |
| I | Revoked service membership | **FAILS CLOSED** — existing `MembershipNotActiveError`, unmodified |
| J | Service principal somehow assigned `approverRole` | **FAILS CLOSED at two independent layers** — `resolveTrustedContext` strips it structurally regardless of the membership row, and no live handler in the repository can assign `approverRole` to any identity at all today |
| K | Org A's channel attempting Org B's CMS access | **PREVENTS** — the service identity's only membership is its own org; `resolveTrustedContext` fails with `MembershipNotFoundError` for any other |
| L | Replayed provider event | **REQUIRES W2B CONTROL** — the wamid-dedup table is designed (W2 architecture doc §17/§23) but not yet built |
| M | Duplicate provider message | **REQUIRES W2B CONTROL** — same mechanism as L |
| N | Leaked/rotated provider credential | **REQUIRES W2B CONTROL** — rotation reuses the existing `ConnectorSecretProvider` reference-swap mechanism (sufficient once triggered); the operational rotation runbook itself is not yet written |
| O | Compromised AI output requesting an unauthorized operation | **PREVENTS** — the model's only output is a closed-enum `StructuredIntent`; there is no field or mechanism by which its output could invoke an operation outside what deterministic policy code already decides |

No unresolved critical path remains. L/M/N are legitimately deferred to W2B implementation (mechanisms named, not yet built) — none represents a gap in this ADR's authority design itself.

## Consequences

- `identity-access` package: **no changes**. Verified during W2-ARCH final review that its existing `canAdministerMembership()` guard already fully covers the entire administrative mutation surface (see "Narrow Capability" above) — no defense-in-depth addition needed there.
- `application-services` package: **no changes** to existing files; the new `resolveChannelServiceContext` function and `ChannelEventVerifier` interface live in the new W2 communication package, not here — `application-services`'s existing `clinicOperationsHandler.ts` is called exactly as it already is today, unaware of who its caller is.
- **Required W2B follow-up (identified during W2-ARCH final review, out of this ADR's own scope):** `packages/clinic-cms-connector`'s `ConnectorExecutionEvidence` (W1B) records `organizationId`/`connectionId`/`operation`/`correlationId`/`outcome` but has no field attributing WHICH identity/principal triggered a given clinic operation — true for human-triggered calls today and would remain true for service-principal-triggered calls under this ADR. Not a defect in this ADR's authority mechanism (which is fully attributable via `identityAuditEvents.actorPrincipalType`, already correct), but a narrow, additive schema gap worth closing before multiple channels/principals per organization make "which principal did this" a real operational question. Recommend adding an optional `actorIdentityId`/`actorPrincipalType` pair to that evidence type in W2B, not blocking this ADR's approval.
- **Operational requirement**: a documented, human-operated provisioning step per clinic/channel — no automated self-provisioning.

## Deferred Decisions

- Whether a future second automated channel (e.g., a future SMS or Gmail integration) reuses one shared service identity per organization or gets its own — recommend one per channel for cleaner revocation granularity, not decided here.
- Whether Candidate B (`ServicePrincipalScope`) is ever built — remains available if a materially different service-access model is needed later.
- The exact `CommunicationChannelRepository`/`ChannelEventVerifier` implementation details — this ADR fixes the authority *pattern*, not the full W2B code, which remains a separate implementation task once this ADR and CLINIC-W2's other approved decisions permit starting it.

## Decision Register

Recorded as `ARCH-019` in `docs/11_Decisions.md`.

---

## Founder Decision — APPROVED

**Approved:** the non-human authority pattern described in this ADR — a `ChannelEventVerifier`-produced `VerifiedPrincipal` for a pre-provisioned, organization-scoped `principalType: 'service'` identity, resolved through the existing, unmodified `AuthorizationService.resolveTrustedContext()`, with `organization_memberships` reused directly (Candidate A) rather than building a new `ServicePrincipalScope` mechanism (Candidate B). Condition of approval: the required W2B follow-up noted under "Consequences" (attributable evidence for connector actions) is tracked, not dropped, even though it does not block this ADR itself. W2B implementation of this pattern (the `ChannelEventVerifier`, the provisioning tooling, and their tests) may now begin as part of CLINIC-W2B, subject to every other still-open item in `docs/integrations/CLINIC_W2_COMMUNICATION_ARCHITECTURE.md`.
