# Samvardiq Skill Registry

## Skill Identity
Skill ID:
Skill Name:
Samvardiq Executive:
Domain Expert:
Source Repository:
Source Version/Commit:
License:

## Classification
[ ] REUSE
[ ] WRAP
[ ] FORK_AND_ADAPT
[ ] BUILD
[ ] REJECT

## Security
External Network Access:
Filesystem Access:
Shell Access:
Credential Requirements:
Patient Data Exposure:
Prompt Injection Risk:

## Samvardiq Integration
Inputs:
Outputs:
Required Connectors:
Required Approval Level:
ECP Compatibility:
Audit Requirements:
Healthcare Adaptation:

## Status
CANDIDATE / AUDITED / APPROVED / INTEGRATED / VALIDATED / RETIRED

---

## Wave 1 — CMO / Marketing Intelligence

### Source Repository A

Repository: alirezarezvani/claude-skills  
Approved Baseline Commit:
19392f7a08264ed00486a251f5b2098321771f94

License: MIT

Classification:
APPROVED_FOR_CONTROLLED_ADAPTATION

Selected capabilities:

- cmo-advisor
- marketing-ops
- marketing-context
- local-seo-manager
- campaign-analytics
- analytics-tracking
- seo-audit
- schema-markup
- content-strategy
- content-production
- social-media-manager
- social-content
- page-cro
- form-cro
- ab-test-setup

Import Policy:

Samvardiq SHALL NOT import the entire upstream repository.

Only explicitly approved skills and their required local
references/scripts may enter the Samvardiq skill layer.

All imported capabilities must remain pinned to an exact upstream
commit and registered with Skill Steward.

---

### Healthcare Adaptation Requirements

#### local-seo-manager

Classification:
FORK_AND_ADAPT

Target Samvardiq Skill:
healthcare-local-growth

Required changes:

- replace US service-business assumptions
- support Indian healthcare organizations
- support MedicalClinic / Physician entities
- prioritize Google Business Profile and Google Maps
- remove irrelevant US directories
- support Indian addresses and telephone formats
- remove unsupported ranking assumptions
- prohibit fake/rewarded/manipulated reviews
- integrate clinic enquiry and OP conversion metrics
- connect recommendations to Samvardiq approval governance

#### analytics-tracking

Classification:
FORK_AND_ADAPT

Target Samvardiq Skill:
healthcare-marketing-analytics

Required changes:

- prohibit clinical or patient-identifiable information in
  advertising/analytics systems
- separate CMS patient identity from marketing analytics identity
- use minimum-necessary conversion events
- integrate GBP → enquiry → booking → attendance → follow-up funnel
- support organization-scoped analytics
- require governance approval for tracking changes

#### campaign-analytics

Classification:
WRAP_AND_REUSE

Healthcare funnel shall support:

GBP visibility
→ interaction
→ enquiry
→ appointment requested
→ appointment booked
→ appointment confirmed
→ patient attended
→ consultation completed
→ follow-up
→ review

---

### Source Repository B

Repository: hyperfx-ai/marketing-skills

Approved Evaluation Commit:
bb080b81e2b633c4d46cd8d38d31f14ad95b478a

License: MIT

Status:
APPROVED_FOR_OPTIONAL_CONNECTOR_EVALUATION

Candidate Skills:

- analytics-insights
- competitor-intel
- seo-research
- google-ads
- meta-ads

Initial Policy:

READ-ONLY ONLY.

No advertising, analytics, GTM, social, or other external mutation
shall be enabled until Samvardiq Approval & Governance explicitly
authorizes the action.

Hyper MCP is an external dependency and SHALL NOT become a required
component of Samvardiq Core.

---

### Source Repository C

Repository: noduslabs/claude-seo-skill

Evaluated Commit:
069aef92a6ed86405daa0f07a1b793f1c6359796

Status:
HOLD

Reason:

No repository license was detected during the initial audit.

Do not copy, vendor, modify, or distribute this skill inside
Samvardiq until licensing rights are established.

---

## Wave 1 Decision

Samvardiq will reuse audited open-source reasoning and workflow
skills where doing so reduces unnecessary implementation.

Samvardiq retains ownership of:

- Executive orchestration
- Executive Communication Protocol
- Goal Orchestration
- organization intelligence
- healthcare governance
- approval control
- healthcare-specific domain skills
- CMS integration
- GBP-to-OP attribution
- organizational memory
- learning
- outcome validation

External skills are capabilities used by Samvardiq.

They are not architectural authorities.

Status:
APPROVED_PLANNED

---

## CMO-W1 Session 1 — Implementation Record

Implemented:
CMO Executive -> Marketing Skill Router -> Domain Expert -> Structured
Recommendation vertical slice, at
`packages/marketing-intelligence/`.

Runtime skills registered (status: INTEGRATED, invokable):

| Skill ID | Samvardiq Executive | Domain | Source | Source Version | License |
|---|---|---|---|---|---|
| cmo-advisor | CMO | marketing | alirezarezvani/claude-skills | 19392f7a08264ed00486a251f5b2098321771f94 | MIT |
| marketing-ops | CMO | marketing | alirezarezvani/claude-skills | 19392f7a08264ed00486a251f5b2098321771f94 | MIT |
| healthcare-local-growth | CMO | marketing | alirezarezvani/claude-skills (local-seo-manager, FORK_AND_ADAPT) | 19392f7a08264ed00486a251f5b2098321771f94 | MIT |
| campaign-analytics | CMO | marketing | alirezarezvani/claude-skills (WRAP_AND_REUSE) | 19392f7a08264ed00486a251f5b2098321771f94 | MIT |

No upstream code was vendored. Each skill is an original TypeScript
implementation of the capability and healthcare adaptation requirements
already approved above; the source fields exist to preserve
attribution and pin the approved upstream baseline, not to indicate a
copied file.

No external system (GBP, GA4, WhatsApp, Gmail, CMS, advertising
account) was connected. No automation/execution code path exists in
this package — CMO produces recommendations only.

Package manager: npm is the current package manager for the
`packages/marketing-intelligence` package only. This does not
establish a monorepo-wide package-manager architecture decision —
no repository-wide tooling, workspace config, or lockfile convention
exists yet. `package-lock.json` is tracked for this package;
`node_modules/`, `dist/`, and `.env*` remain gitignored.

Validation: typecheck, lint, unit tests (7/7), and production build
all pass locally. See `docs/11_Decisions.md` for architectural
authority; this record does not introduce a new decision.

Status:
IMPLEMENTED_VALIDATED

Not CANONICAL_STABLE until reviewed and merged into protected `main`
per repository governance.

Correction (CMO-W1 Session 2): the Session 1 report described
`docs/04_Architecture.md` as covering "all 7 SOSA layers." The
canonical file itself was never 7-layer — it documents all 11 SOSA
layers in full (Organization Intelligence, Executive Board, Domain
Expert, Goal Orchestration, Recommendation, Approval & Governance,
Automation Engine, Data, Memory, Learning, Knowledge; see ARCH-010).
Only that summary sentence was wrong. No architecture file and no
source code in either package encoded a 7-layer assumption.

---

## CMO-W1 Session 2 — Implementation Record (SOSA Layer 6)

Implemented:
Approval & Governance Layer boundary — Recommendation -> Approval
Request -> Human Decision -> Approval Record -> STOP — at
`packages/approval-governance/`.

This layer is domain-agnostic (not CMO-specific): it accepts any
Recommendation Layer output that structurally satisfies
`RecommendationRef` (recommendationId, organizationId, goalId,
approvalRequirement, risk, title). `src/` has no dependency on
`@samvardiq/marketing-intelligence`; that package is wired in only as
a `file:../marketing-intelligence` devDependency of the test suite, to
prove the real Session 1 `Recommendation` shape flows through
unmodified in `test/vertical-slice.test.ts`.

No executor, HTTP client, connector, job queue, or GBP/GA4/WhatsApp/
Gmail/CMS/advertising call exists anywhere in this package. No
production database was introduced — persistence is an in-memory
`ApprovalRepository`/`ApproverDirectory` behind interfaces, so a
future Data Layer implementation can replace them without changing
governance behavior.

Validation: typecheck, lint, unit tests (10/10), and production build
all pass locally. Combined with Session 1: 17/17 tests passing across
both packages.

Status:
IMPLEMENTED_VALIDATED

Not CANONICAL_STABLE until reviewed and merged into protected `main`
per repository governance.