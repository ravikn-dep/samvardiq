# ADR-IDENTITY-001 — Authentication and Trusted Organization Access Architecture

**Status:** APPROVED — 2026-09-08, by the Founder, with the
implementation constraints recorded in IDENTITY-W1/W2 (see
`docs/11_Decisions.md` `ARCH-016`, which records this decision using
the existing decision-register format; that entry is authoritative
alongside this document, not a replacement for it). Approval of the
architecture and principles described here does not itself mark any
code `IMPLEMENTED_VALIDATED` — implementation status is tracked
separately in `packages/identity-access/` and the IDENTITY-W2 session
report.

**Session:** IDENTITY-W1A (proposed), IDENTITY-W1 (approved)

**Depends on:** `docs/decisions/ADR-DATA-001.md` (ARCH-015),
`packages/data-foundation/` (DATA-W3), `packages/approval-governance/`
(CMO-W1 Session 2).

---

## Context

DATA-W3 implemented real PostgreSQL persistence with Row Level Security
for `Organization → Goal → Recommendation → ApprovalRequest →
ApprovalRecord`, and documented its own boundary honestly:
`withOrganizationContext()` sets `app.current_org_id` from whatever
`organizationId` string the calling code passes in. That protects the
database from *unscoped* access. It does not yet verify that the
caller supplying that `organizationId` is a real, authenticated
identity with an actual, current right to act as that organization.
This ADR is the architecture that closes that gap — as a proposal to
review and approve, not as implemented code.

---

## Trust Gap

```
repository receives organizationId
        ↓
withOrganizationContext()
        ↓
SET LOCAL app.current_org_id
        ↓
PostgreSQL RLS
```

`organizationId` today is trusted the moment it's passed in. Nothing
upstream of `withOrganizationContext()` currently exists to answer "is
the caller who they claim to be, and are they actually allowed to act
as this organization, right now?"

Target trust chain:

```
Authenticated Identity
        ↓
Organization Membership
        ↓
Role / Permissions
        ↓
Authorized Organization Selection
        ↓
Trusted Organization Context
        ↓
Application Service
        ↓
Database Transaction
        ↓
SET LOCAL app.current_org_id
        ↓
PostgreSQL RLS
```

---

## Security Invariants

1. A client may **request** access to an organization. A client must
   **never** be trusted to **establish** authorization for that
   organization merely by supplying `organizationId`.
2. Trusted organization context is derived from verified identity +
   active organization membership + authorization policy — never from
   a client-supplied claim alone.
3. RLS remains defense-in-depth, not a replacement for authorization,
   and is not weakened or bypassed by this architecture.
4. No repository, service, or database role added by this ADR may be
   more privileged than what DATA-W3 already established for
   `samvardiq_app`.
5. An AI/service principal can never acquire human approval authority
   (reinforces, does not replace, the already-implemented and tested
   `AiSelfApprovalError` invariant in `approval-governance`).

---

## Requirements

Extracted from this session's brief and from what DATA-W3's own
`withOrganizationContext()` doc comment already flagged as deferred:

- Verified authentication (who are you).
- Organization membership as the authorization source of record,
  **owned by Samvardiq**, not by the identity provider.
- Support one-user-to-one-org and one-user-to-many-orgs without a
  future redesign.
- A typed `TrustedOrganizationContext` concept that every organization-
  scoped application service accepts instead of a raw `organizationId`.
- Membership freshness: revocation must take effect promptly, not only
  at token expiry.
- Reconciliation with the *existing, already-implemented*
  `ApproverRole`/`ROLE_AUTHORITY` system in `approval-governance` —
  not a second, competing role system.
- A path for future service/AI/connector identities that is
  architecturally ready without being built now.
- Platform administration that does not grant automatic tenant access.
- No patient/clinical data, no clinical authorization model.

---

## Threat Model

| Threat | Mitigation in this design |
|---|---|
| Stolen session | Provider-managed short-lived tokens (not hand-rolled); authorization is re-derived per operation, so a stolen session's blast radius is bounded by the victim's *current* memberships, not by whatever the token happens to encode. |
| Tenant ID tampering | `TrustedOrganizationContext` is always re-derived server-side from a fresh membership lookup; RLS is the independent backstop even if an application-layer bug let a bad `organizationId` through. |
| Revoked membership | Membership status is read fresh on every `TrustedOrganizationContext` establishment — never cached in, or trusted from, a long-lived token. See "Session & Membership Freshness." |
| Suspended account | `SUSPENDED` fails the same "membership ACTIVE?" gate as `REVOKED` for authorization purposes — distinguished only for record-keeping and reactivation, not for access. |
| Stale token | The token proves identity only. Authorization staleness is bounded by per-request membership freshness, not token TTL. |
| Privilege escalation | Role changes are membership-table writes with their own audit event (see "Audit Requirements"); the coarse 3-role membership model minimizes the surface for subtle escalation bugs. |
| Cross-organization IDOR | Two independent layers: membership-scoped `TrustedOrganizationContext` at the application boundary, RLS at the database boundary (unchanged from DATA-W3). |
| Platform-admin misuse | Platform admin is a separate, explicitly-granted, auditable table — never automatic tenant membership; tenant access requires a further, separately-audited break-glass grant. See "Platform Administration." |
| Service credential compromise | Service principals are scoped to exactly one organization each via their own grant table (not the human membership lifecycle); least privilege by construction. |
| AI impersonating human | `principalType` is a hard field on every identity; `Approver.kind` (existing) is derived 1:1 from it, never set independently; service principals are never granted `approverRole`. |
| Session fixation | Delegated to the chosen provider's maintained session implementation rather than hand-rolled session code (a direct factor in the provider decision below). |
| CSRF | Not yet applicable — no HTTP/API layer exists in this repository yet. Flagged as a requirement for whichever transport is built next, not ignored. |
| Replay | Short tokens + per-request membership freshness bound replay value even if a token is captured. |
| Audit gaps | Explicit identity-event audit list below, modeled on the same append-only philosophy already proven for `approval_records` in DATA-W3. |

---

## Candidates

Evaluated against current documentation (not stale assumptions) via
live research during this session.

### A. Supabase Auth

Lives in the *same* Postgres project already selected in ADR-DATA-001
— no separate vendor, no cross-system membership sync needed to know
"which Samvardiq identity is this." Provides MFA (TOTP/phone), OAuth,
SAML SSO for future enterprise IdP federation, magic-link/passwordless.
Has **no built-in "organizations" primitive of its own** — Supabase's
own guidance for multi-tenancy is "inject your own tenant id and use
RLS," which is exactly what this ADR proposes Samvardiq to own anyway.
GoTrue (the underlying auth server) is open source and self-hostable,
bounding the portability risk.

### B. Auth.js / application-managed authentication

Maximum flexibility, zero vendor dependency, but current guidance
(verified live) is that it is *not recommended for new multi-tenant
projects* without substantial custom build-out — no native
organization/session-security tooling, meaning Samvardiq would be
hand-rolling session security itself, a materially higher-risk surface
than delegating to a maintained provider.

### C. Clerk

Excellent developer experience and a first-class "Organizations"
primitive out of the box. The organization/membership data lives in
Clerk's own system, not Samvardiq's Postgres — using it as the source
of truth would require a webhook-sync pipeline to mirror membership
into our own tables, directly conflicting with "Samvardiq owns
authorization." A separate paid vendor from the Postgres/Supabase
hosting already approved; the B2B organizations tier costs $100/mo
beyond a limited free tier — a real recurring cost for a pre-revenue,
one-clinic pilot.

### D. Auth0

Best-in-class enterprise SSO breadth (SAML/OIDC/WS-Fed/AD, Okta
pedigree), strong for a *future* hospital-IT-department integration.
Same cross-system membership-sync problem as Clerk. Publicly
acknowledged even in its own ecosystem to not have been "built
tenant-first" — added B2B complexity layered on later. A B2B-specific
tier now costs ~$150/mo — the highest recurring cost of any candidate,
disproportionate to current pilot scale.

### E. Better Auth (self-hosted, open source)

Named because it came up directly in live research as a genuine
alternative with a first-class organization plugin. Self-hosted, no
vendor lock-in, but younger/less battle-tested than the others, and
self-hosting adds operational burden this small team doesn't currently
carry for auth infrastructure (versus Supabase Auth, which rides along
with hosting already approved). Its org-plugin schema would need the
same "don't adopt it as the source of truth" treatment as Clerk/Auth0's
org features, for the same "Samvardiq owns authorization" reason.

---

## Weighted Decision Matrix

Weights as specified in the session brief (unmodified — not tuned to
favor an outcome):

| Criterion (weight) | A: Supabase Auth | B: Auth.js | C: Clerk | D: Auth0 | E: Better Auth |
|---|---|---|---|---|---|
| Security (25%) | 8 | 6 | 8 | 9 | 6 |
| Architecture fit (20%) | 9 | 6 | 5 | 5 | 7 |
| Healthcare evolution (15%) | 7 | 5 | 6 | 7 | 5 |
| Portability (10%) | 8 | 9 | 5 | 5 | 8 |
| Enterprise evolution (10%) | 7 | 4 | 8 | 9 | 5 |
| Developer experience (10%) | 8 | 5 | 9 | 6 | 7 |
| Operations (5%) | 8 | 6 | 6 | 5 | 5 |
| Pilot cost/practicality (5%) | 9 | 7 | 6 | 4 | 8 |
| **Weighted score** | **80.0** | **59.0** | **67.0** | **67.5** | **63.0** |

Supabase Auth wins primarily on **architecture fit** (no cross-system
membership sync — a structural advantage the others cannot close
without extra integration surface) and **operations/pilot cost** (no
new vendor beyond hosting already approved in ADR-DATA-001). This is
not a security-first win — Auth0 scores higher on raw security
pedigree — but the architecture-fit and cost gap is large enough, and
directly aligned with the "Samvardiq owns authorization, not the
provider" principle this ADR treats as a hard requirement, not a
preference.

---

## Proposed Architecture (Approved)

> **Approved 2026-09-08 (`ARCH-016`).** This describes the approved
> architecture and its invariants. Whether a given piece of it has
> actually been *implemented* is tracked separately — see the
> IDENTITY-W2 session report for what was built versus deferred.

- **Authentication provider:** Supabase Auth.
- **Internal identity model:** Samvardiq-owned `identityId` is the
  universal domain identity (never a provider subject id directly —
  see "Identity Model").
- **Membership model:** Samvardiq-owned `organization_memberships`,
  composite `(organization_id, identity_id)` — same key pattern DATA-W3
  already established and tested (reused, not reinvented).
- **Organization role model:** `OWNER`, `MEMBER`, `VIEWER` — three
  levels (trimmed from the session brief's five illustrative levels;
  see "Role Model" for why).
- **Approval authority relationship:** unchanged — `ApproverRole`/
  `ROLE_AUTHORITY` in `approval-governance` remains the sole approval-
  authority system; membership optionally *grants* it via a nullable
  `approverRole` field, never duplicates it.
- **Trusted-context mechanism:** `TrustedOrganizationContext`, resolved
  fresh per operation from a real membership-table read — never from a
  token claim alone.
- **Service identity strategy:** same `identities` table
  (`principalType = 'service'`), a *separate* `service_principal_scopes`
  grant table (not the human membership lifecycle).
- **RLS relationship:** unchanged. `withOrganizationContext()`, the RLS
  policies, and the 5 DATA-W3 tables require zero modification — the
  identity layer is strictly upstream.
- **Session/membership freshness strategy:** authorization is re-derived
  from the membership table on every `TrustedOrganizationContext`
  establishment; the token proves identity only, never current
  authorization.
- **Platform-admin strategy:** a separate `platform_administrators`
  grant table; tenant access requires a further, separately-audited
  break-glass grant — never automatic.
- **Audit strategy:** append-only `identity_audit_events`, modeled on
  the same philosophy already proven for `approval_records`.
- **Provider portability strategy:** all provider-specific logic
  isolated behind one identity adapter; membership/role/governance data
  — the actual valuable state — lives in Samvardiq's own Postgres
  regardless of provider.

---

## Identity Model

```
Identity {
  identityId          // Samvardiq-generated, e.g. UUID — the universal domain identity
  principalType        // 'human' | 'service'
  authProviderSubject   // Supabase auth.users.id — nullable; NULL for service principals
  displayName
  status                // 'active' | 'disabled'
  createdAt
  updatedAt
}
```

`identityId`, not `authProviderSubject`, is what every other table in
this ADR (and every future domain table that needs to reference "an
actor") references. Reasoning, directly answering the session's
explicit instruction to avoid making a provider ID the universal
identity "unless strongly justified": a provider-subject id cannot
represent a service/AI principal at all (they don't sign in via
Supabase Auth), so it cannot be the *universal* identity even if it
were adequate for humans; and if Samvardiq ever adds a second
authentication path (a different SSO namespace, a future different
provider), only a new `authProviderSubject` mapping is needed — no
change to any table that already references `identityId`.

---

## Organization Membership Model

```
OrganizationMembership {
  organizationId       // composite PK with identityId — same pattern as DATA-W3's other tables
  identityId
  role                  // 'OWNER' | 'MEMBER' | 'VIEWER'
  approverRole?          // ApproverRole | null — an OPTIONAL grant of existing governance authority
  status                 // 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED'
  invitedBy?              // identityId, nullable
  createdAt
  activatedAt?
  suspendedAt?
  revokedAt?
  updatedAt
}
```

Every field is justified by a named requirement, not carried over by
default from the session brief's illustrative list:

- Composite `(organizationId, identityId)` PK: one identity has at
  most one membership row per organization; this also gives the table
  the same org-scoping property RLS already depends on for every other
  table, for free, by construction — directly reusing DATA-W3's
  precedent rather than inventing a different key shape for this one
  table.
- `status` values matter for authorization (`ACTIVE` gates access;
  everything else denies) *and* independently for audit/UX (was this
  person invited but never accepted? suspended temporarily vs. revoked
  permanently?) — both are named requirements (section 7 and the audit
  model), so both are kept.
- `approverRole` is nullable specifically because most memberships will
  never carry governance approval authority — it is a grant, not a
  default.
- Timestamps per named lifecycle event (`activatedAt`/`suspendedAt`/
  `revokedAt`) exist because each transition is independently listed
  under "Audit Requirements" below — not padding.

`REVOKED` rows are never deleted (consistent with the no-silent-loss
posture already established for `approval_records`), but unlike
`approval_records` a membership *can* be legitimately reactivated by a
later re-invitation — this ADR does not settle whether reactivation
reuses the same row or creates a new one; see "Deferred Decisions."

---

## Role Model

Three axes, kept explicitly separate — this is the direct resolution
of "do not create two incompatible role systems":

1. **Platform role** — `SUPER_ADMIN` only, tracked in its own grant
   table (`platform_administrators`), never mixed into organization
   membership roles. See "Platform Administration."
2. **Organization membership role** — `OWNER` / `MEMBER` / `VIEWER`.
   Trimmed from the session brief's illustrative five-level example
   (`OWNER/ADMIN/MANAGER/STAFF/VIEWER`) because nothing in the current
   repository yet distinguishes what an `ADMIN` could do that an
   `OWNER` couldn't, or what a `MANAGER` could do that `STAFF`
   couldn't — no feature, service, or API exists yet to hang that
   distinction on. Three levels (can manage the organization itself /
   can operate day-to-day / read-only) cover every capability this ADR
   can actually name a requirement for, and growing to five levels
   later is an additive enum change, not a schema redesign. This is a
   deliberate application of "avoid premature fine-grained permission
   explosion."
3. **Approval authority** — `ApproverRole` / `ROLE_AUTHORITY`, **entirely
   unchanged** from `approval-governance`. A membership *may* carry an
   `approverRole` grant; the six-value fine-grained governance role set
   already exists and already has its own authority-level mapping, so
   organization-membership role does not need to duplicate that
   granularity.
4. **AI/service** — `principalType = 'service'` on the identity; a
   service identity's membership-equivalent (`service_principal_scopes`)
   never carries an `approverRole`, structurally reinforcing the
   already-tested `AiSelfApprovalError` invariant rather than
   introducing a new check that could drift from it.

`Approver.kind` (existing, `'human' | 'ai'`) must be derived 1:1 from
`identity.principalType` when a future `PostgresApproverDirectory` is
built — never set independently — to prevent exactly the "AI/human
identity confusion" failure class named in this session's own review
checklist.

---

## Trusted Organization Context

```
TrustedOrganizationContext {
  identityId
  organizationId
  membershipId       // = (organizationId, identityId) — proof an ACTIVE membership was matched
  role                // organization membership role
  approverRole?        // present only if this membership carries governance authority
  principalType
  establishedAt        // when this context was resolved, for audit/freshness
}
```

Authoritative fields: everything above is derived server-side from a
fresh membership-repository read at the moment of establishment. Never
authoritative: any `organizationId`, `role`, or context object supplied
directly by a client — a client may only ever *request* an
organization; this object is what a request becomes only after that
request survives membership validation.

Layering note, to preempt confusion about whether DATA-W3 code changes:
future **application services** (not yet built — no HTTP/API layer
exists in this repository) should accept `TrustedOrganizationContext`,
not a raw `organizationId`, and extract `.organizationId` from it
before calling into `packages/data-foundation`. The **repository layer**
itself needs no change — it already only ever receives a plain
`organizationId` string, and by the time a call reaches it, trusted
context has already been established one layer up. `withOrganizationContext()`
is not modified by this ADR.

Request lifecycle:

```
HTTP/API request
       ↓
authenticate session/token (Supabase Auth)
       ↓
resolve internal identity (authProviderSubject -> identityId)
       ↓
requested organization identifier (client-supplied, untrusted)
       ↓
membership lookup (organizationId, identityId) -> membership row
       ↓
membership ACTIVE?  -- no -> deny
       ↓
role / approverRole read from the membership row
       ↓
TrustedOrganizationContext established
       ↓
application service (accepts TrustedOrganizationContext, not raw organizationId)
       ↓
packages/data-foundation repository (unchanged — still takes organizationId)
       ↓
withOrganizationContext()  -- unchanged
       ↓
SET LOCAL app.current_org_id  -- unchanged
       ↓
PostgreSQL RLS  -- unchanged
```

---

## RLS Integration

Five distinct responsibilities, kept distinct on purpose:

| Layer | Question it answers |
|---|---|
| Authentication | Who are you? |
| Membership | Which organizations do you belong to? |
| Authorization | What may you do there? |
| Trusted Context | Which authorized organization is this specific operation acting within? |
| RLS | Does the database itself permit this transaction to touch this organization's rows? |

RLS does not know about identities, memberships, or roles, and this
ADR does not teach it any of that — it continues to trust
`app.current_org_id` exactly as DATA-W3 built it. The new layers exist
precisely so that whatever sets `app.current_org_id` has already done
real authorization work before RLS ever sees the value.

---

## Multi-Organization Switching

A user with memberships in Clinic A and Clinic B authenticates **once**.
"Switching organizations" is not a mutation of their identity or
session — it is simply a new request naming a different
`organizationId`, which goes through the *exact same* membership-lookup
gate as any other request. There is no cached, trusted "currently
active organization" state on the server between requests; any
client-side "last used organization" convenience is a UX hint only and
is re-validated in full on every request, so it cannot leak data from,
or silently authorize action in, a previously active organization it
happens to remember.

---

## Service / Agent Identity

Future AI executives, domain experts, automation workers, connector
workers, and scheduled jobs get `identities` rows with
`principalType = 'service'` and `authProviderSubject = NULL` (they
don't sign in as a human would). Their organization scope is granted
through a **separate** table, not the human membership lifecycle:

```
ServicePrincipalScope {
  organizationId
  servicePrincipalId   // = identityId of a principalType='service' identity
  purpose               // e.g. "clinic-cms-connector", free text for now
  grantedAt
  revokedAt?
}
```

Kept separate from `organization_memberships` deliberately: a service
principal is never "invited," never "suspended" in the human sense, and
must never accidentally acquire `approverRole` through a code path
shared with human onboarding. This directly prepares the ground named
in this session's brief for a future Clinic CMS connector: `Samvardiq
→ Service Identity → Clinic Organization → CMS Connector`, authenticating
as "Samvardiq acting on behalf of Clinic X," never as a doctor's
personal login. No credential material, rotation mechanism, or actual
connector is built or specified here — scope table shape only.

---

## Platform Administration

```
PlatformAdministrator {
  identityId
  grantedBy         // identityId
  grantedAt
  revokedAt?
  reason             // required at grant time
}
```

Being a platform administrator grants **no automatic membership in any
organization** — it is entirely separate from `organization_memberships`.
Tenant impersonation defaults to **denied**. If a future support
workflow needs it, this ADR's position is that it must be a further,
separately-audited, time-boxed **break-glass** grant — with a required
reason and an approving identity — that still produces an ordinary
`TrustedOrganizationContext` (flagged as break-glass) rather than
bypassing the context mechanism or RLS. Not implemented or fully
specified here; see "Deferred Decisions."

---

## Session & Membership Freshness Strategy

The answer to this session's explicit question — "if membership is
revoked, how fast must Samvardiq stop honoring the existing session for
that organization?" — is: **on the very next request**, because
authorization is never read from the token. The Supabase Auth session
token's only job is proving identity (who you are); `TrustedOrganizationContext`
is re-derived from a live membership read every time it's established.
There is no reliance on token expiry/refresh cycles for authorization
freshness — a revoked membership is invisible to the very next
membership lookup regardless of how much of the token's lifetime
remains.

The durable invariant is **sufficiently fresh, authoritative
authorization** — not a permanent architectural commitment to exactly
one SQL query per future HTTP request forever. IDENTITY-W2 implements
direct, uncached membership verification because that is the correct
starting point and nothing yet justifies added complexity; a later,
explicitly-bounded freshness cache is a legitimate future optimization
*as long as* it cannot serve a revoked or suspended membership as
authorized. That boundary condition, not the specific lookup mechanism,
is what this ADR actually requires.

---

## Failure Model

Every case fails closed. No case falls back to a client-supplied
`organizationId` as a substitute for a real authorization decision.

| Condition | Result |
|---|---|
| No authenticated identity | Deny — no `TrustedOrganizationContext` is ever established. |
| Unknown identity (valid provider token, no matching `identities` row) | Deny — treated identically to unauthenticated, not auto-provisioned mid-request. |
| No membership row for the requested organization | Deny. |
| Membership `INVITED` | Deny — not yet `ACTIVE`. |
| Membership `SUSPENDED` | Deny — identical access outcome to `REVOKED`; distinguished only for record-keeping. |
| Membership `REVOKED` | Deny. |
| Unknown/nonexistent organization | Deny — cannot structurally have a membership row. |
| Insufficient role for the requested action | Deny at the application-service authorization check, using `role`/`approverRole` already present on the established context. |
| Malformed token | Deny at the authentication step, before identity resolution begins. |
| Expired token | Deny/require re-authentication at the authentication step. |
| Identity-provider outage (verification cannot be performed or trusted) | Deny. Availability of the identity provider is never treated as equivalent to a positive authorization decision — if Supabase Auth cannot be reached or a token cannot be verified, no `TrustedOrganizationContext` is established, full stop. This applies even to previously-valid sessions; there is no local fallback verification path that trusts an unverifiable token. |
| Invalid/unknown service principal | Deny — same path as unknown human identity. |

---

## Audit Requirements

To be built as an append-only `identity_audit_events` table, following
the same philosophy DATA-W3 already proved for `approval_records`
(insert-only, no update/delete grant, immutability trigger as a second
layer). Events to eventually cover: login, logout, failed
authentication, membership invitation, membership activation, role
change, membership suspension, membership revocation, organization
switch, privileged (platform-admin) action, break-glass access grant
and use, service-principal creation/revocation. Not built this session.
This scope is deliberately limited to identity-security events — it is
not a generic enterprise audit platform, and should not grow into one
without a separate, explicit decision to do so.

---

## Healthcare Security Evolution

No patient, clinical, or diagnosis data is introduced or modeled here —
this remains an organizational/governance identity layer, matching the
same boundary DATA-W3 already drew and tested for its own tables. No
provider choice in this ADR is claimed to create HIPAA, DPDP, or GDPR
compliance by itself — Supabase Auth's SAML SSO and MFA are useful
building blocks for a future compliance posture, not a compliance
guarantee. The service-principal design is what makes a future CMS
connector possible without using a clinician's personal credentials —
the specific privacy/compliance boundary for clinical data itself
remains entirely future work, deliberately out of scope here as it was
in DATA-W1/DATA-W3.

---

## Provider Portability

Supabase Auth is treated as infrastructure for authentication only, the
same posture ADR-DATA-001 already established for Supabase-as-hosting.
The actual valuable state — `identities`, `organization_memberships`,
`service_principal_scopes`, and everything approval-governance already
owns — lives in Samvardiq's own Postgres tables, addressed by
Samvardiq's own `identityId`, never by a provider subject id directly.
Migrating authentication providers later means replacing one adapter
(how `authProviderSubject` gets populated and verified) — not
rebuilding membership, roles, or governance data. Provider-specific
logic must stay behind a single identity-adapter boundary
(`Identity Provider → Identity Adapter → Identity Resolution →
Membership Repository → Authorization Service → TrustedOrganizationContext
→ Application Services`) — scattering `if (supabaseUser...)`-shaped
checks through domain packages is explicitly rejected by this
architecture, not merely discouraged.

---

## Consequences

- No changes to `packages/data-foundation` or `packages/approval-governance`
  are required to adopt this architecture — it is additive and sits
  entirely upstream of both.
- A future implementation session will need to build: `identities`,
  `organization_memberships`, `service_principal_scopes`,
  `platform_administrators`, `identity_audit_events` tables (RLS'd the
  same way as DATA-W3's tables — every one of them is organization- or
  identity-scoped); an identity adapter for Supabase Auth; a
  `TrustedOrganizationContext` resolution service; and eventually a
  `PostgresApproverDirectory` that reads governance authority from
  `organization_memberships.approverRole` instead of the current
  manually-registered `InMemoryApproverDirectory`.
- Every future organization-scoped application service must accept
  `TrustedOrganizationContext`, never a raw `organizationId`, once this
  is built.

## Risks

- Supabase Auth has no native "organizations" feature — this is treated
  as an advantage (forces Samvardiq to own authorization, as intended)
  but means more of the membership/role logic must be built and
  maintained in-house compared to Clerk/Auth0's more complete
  off-the-shelf offering. Mitigated by the fact that this logic is
  genuinely simple (3 roles, one grant table for approval authority)
  and is exactly the state Samvardiq needs to own regardless of
  provider.
- A coarse 3-level organization role may need to grow later (e.g., a
  genuine need to distinguish "can manage billing" from "can manage
  staff"). Mitigated: additive enum growth, not a schema redesign,
  because the role field and its consumers are already isolated behind
  the membership table.
- Break-glass platform access, if built carelessly later, is a real
  privilege-escalation risk. This ADR intentionally does not fully
  specify it — flagged as a deferred decision requiring its own review
  when actually built, not rubber-stamped now.

## Deferred Decisions

Explicitly **not** decided by this ADR:

- Exact reactivation semantics for a `REVOKED` membership (new row vs.
  status flip).
- Full break-glass workflow (approval process, time-box duration,
  exact audit shape).
- Service-principal credential mechanism and rotation policy.
- The identity-adapter's exact interface/module boundaries in code.
- Whether `organization_memberships.role` ever needs a 4th/5th level,
  and what capability would justify it.
- CSRF/session-transport specifics — deferred until an actual HTTP/API
  layer is chosen.
- Any migration, schema DDL, or actual table creation — conceptual
  design only, per this session's explicit restriction.

---

## Founder Decision — APPROVED (2026-09-08)

**Approved:** Supabase Auth as the authentication provider, behind an
identity provider adapter; Samvardiq owning all authorization state
(`identities`, `organization_memberships`, `service_principal_scopes`,
`platform_administrators`) in its own Postgres tables; the 3-level
organization role model (`OWNER`/`MEMBER`/`VIEWER`) with approval
authority granted separately via the existing, unchanged `ApproverRole`
system; and the `TrustedOrganizationContext` pattern as the only
sanctioned way any future application service may act on behalf of an
organization. Recorded as `ARCH-016` in `docs/11_Decisions.md`.

Approval covers the architecture and its invariants, not a specific
code implementation — IDENTITY-W2 implements the provider-independent
identity/membership/trusted-context foundation this ADR describes; live
Supabase Auth integration remains explicitly deferred (see that
session's "Deferred Work").
