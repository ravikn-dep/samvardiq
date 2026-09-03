# ADR-DATA-001 — Samvardiq Transactional Persistence Architecture

**Status:** APPROVED (with amendments) — 03 September 2026. Recorded as
`ARCH-015` in `docs/11_Decisions.md`. See "Approval & Amendments"
immediately below for the exact scope of what was approved; several
implementation specifics further down in this document (primary-key
strategy, the exact immutability mechanism) remain **non-binding
proposals** pending DATA-W3 validation — approval covers the
principles and technology selection, not those specific sketches, and
explicitly leaves the primary-key strategy question open (amendment 8
below).

**Session:** DATA-W2

**Supersedes:** nothing. **Depends on:** `docs/data/DATA_PERSISTENCE_REQUIREMENTS.md`
(DATA-W1), `packages/data-foundation/`, `packages/approval-governance/`,
`packages/marketing-intelligence/` (DATA-W1/CMO-W1 Sessions 1–3).

---

## Approval & Amendments

Approved by the Founder Office, 03 September 2026, with the following
amendments. This supersedes an earlier, less specific approval message
recorded in this session's history — the numbered list below is the
authoritative statement of what was approved; where it narrows or
reframes a statement made later in this document, the amendment
governs.

> 1. Samvardiq adopts PostgreSQL as its transactional database engine.
> 2. Supabase is approved as the initial managed PostgreSQL hosting
>    platform.
> 3. Drizzle is approved as the TypeScript schema/data-access layer.
> 4. Organization isolation must use defense-in-depth:
>    application-level organization-scoped repository contracts, and
>    PostgreSQL Row Level Security.
> 5. Approval/governance transactions must use database transactions
>    where atomicity is required.
> 6. Approval audit records require database-level immutability
>    controls in addition to application-level protections.
> 7. DATA-W3 must validate the exact database-level immutability
>    mechanism against the actual runtime database role.
> 8. Do NOT freeze composite `(organization_id, entity_id)` primary
>    keys as a universal pattern yet. DATA-W3 must compare and
>    validate: composite primary keys, versus globally unique entity
>    IDs + `organization_id` + composite uniqueness / organization-aware
>    foreign keys. Select the simplest design that preserves structural
>    organization isolation and referential integrity.
> 9. Supabase is infrastructure, not an architectural dependency.
>    Samvardiq persistence must remain portable to standard PostgreSQL.

Effect of these amendments on this document:

- **Items 1–3, 5–6, 9 (engine, hosting, ORM, transaction requirement,
  audit-immutability requirement, portability)** — approved exactly as
  originally proposed; no change to this document's substance for
  these.
- **Item 4 (dual-layer isolation)** — approved exactly as proposed;
  restated here for completeness since it is now explicitly numbered
  among the approved amendments rather than implied by the original
  text.
- **Item 7 (immutability mechanism validated against the actual
  runtime database role)** — sharpens the earlier, more generic
  "mechanism TBD in DATA-W3" framing: DATA-W3 must specifically check
  the chosen mechanism against whatever role/privilege the application
  actually connects as at runtime (e.g. a revoked-UPDATE grant is only
  meaningful if the app's own connection role is the one it's revoked
  from — not a superuser or migration role). See "Append-Only Audit"
  below, now annotated accordingly.
- **Item 8 (primary-key strategy explicitly reopened)** — this is new
  relative to the prior approval pass: the "Conceptual Schema" section
  below sketched composite `(organization_id, entity_id)` primary keys
  as *the* proposed pattern. That sketch is now explicitly demoted to
  one of two options DATA-W3 must compare, not a pre-selected design.
  The selection criterion is fixed by this amendment (simplest design
  that preserves structural isolation and referential integrity); the
  choice between the two options is not.
- Everything else in the original proposal not touched by an amendment
  above remains approved as proposed.

---

## Context

DATA-W1 established the logical persistence contract for SOSA Layer 8
— `Organization → Goal → Recommendation → ApprovalRequest →
ApprovalRecord` — as in-memory reference repositories behind explicit
interfaces (`OrganizationRepository`, `GoalRepository`,
`RecommendationRepository`, and an adapter, `PersistentApprovalRepository`,
implementing `approval-governance`'s own `ApprovalRepository` port).
No physical database was chosen at that time.

This ADR is the DATA-W2 output: a technology decision for the physical
database that will eventually back those same interfaces, without
changing their shape more than necessary.

`docs/04_Architecture.md` Layer 8 and `docs/11_Decisions.md` (ARCH-010,
ARCH-011) establish that Data, Memory, Learning, and Knowledge are
separate layers with separate lifecycles, and that the Data Layer must
enforce organization isolation "at Database level, API level, Service
level, Query level, Storage level, Audit level" — not application code
discipline alone. This ADR treats that sentence as a hard requirement,
not aspirational language.

---

## Requirements

Extracted from `docs/data/DATA_PERSISTENCE_REQUIREMENTS.md` and the
actual repository contracts in `packages/data-foundation/src/`:

1. **Organization isolation must be structural**, not just
   query-writing discipline (every `get`/`list` method in DATA-W1 is
   already organization-scoped by signature; the physical database
   must reinforce this independently).
2. **The core referential chain must be enforceable by the engine**:
   `Goal.organizationId → Organization`, `Recommendation.organizationId
   = Goal.organizationId`, `ApprovalRequest.organizationId =
   Recommendation.organizationId`, `ApprovalRecord.approvalRequestId →
   ApprovalRequest` with matching org/goal/recommendation fields.
3. **The terminal approval transition must be atomic**: the
   `ApprovalRequest.status: PENDING → APPROVED|REJECTED|EXPIRED|CANCELLED`
   update and the corresponding `ApprovalRecord` insert must succeed or
   fail together.
4. **`approval_records` must be append-only**, enforced beyond
   application code (DATA-W1 already omits any update/delete method on
   the interface; the physical layer should not rely on that alone).
5. **Deterministic, caller-supplied IDs**, duplicates rejected, never
   silently overwritten (`DuplicateEntityError` in DATA-W1).
6. **TypeScript-first, low-boilerplate data access** that maps cleanly
   onto the repository interfaces already in `packages/data-foundation/`
   and `packages/approval-governance/` — this ADR must not force a
   rewrite of those interfaces beyond one additive method (see
   "Approval Atomicity" below).
7. **No clinical/patient data model exists yet** and this ADR must not
   introduce one; it must only describe how a future clinical
   classification boundary would attach.
8. **Low operational burden at pilot stage** (one design partner
   clinic today; `docs/03_PRD.md` names the growth path toward many
   healthcare organizations).

---

## Candidates

| # | Candidate |
|---|---|
| A | PostgreSQL directly (raw `pg`/node-postgres, hand-written SQL) |
| B | PostgreSQL + Drizzle ORM |
| C | PostgreSQL + Prisma ORM |
| D | Supabase-hosted PostgreSQL + TypeScript data access (paired with Drizzle for the query layer) |
| E | MySQL + a TypeScript ORM (Drizzle/Prisma, both support MySQL) |

A sixth option (a non-relational store — e.g. MongoDB/DynamoDB) was
considered and rejected without a full write-up: the entire DATA-W1
contract is relational by nature (foreign-key chains, composite
uniqueness, transactional multi-row writes) and PRD/Architecture
describe organization/goal/recommendation/approval data as
structured business records, not documents — a document store would
require re-deriving relational integrity in application code, which is
exactly what DATA-W1 already showed is *not* sufficient on its own
(requirement 1). Not evaluated further because it doesn't fit the
requirements, not because it was disqualified for being "not what we
already use."

### A. PostgreSQL directly

**Strengths:** maximum control; native Row-Level Security (RLS); rich
extension ecosystem (`pgcrypto`, `pg_cron`, `uuid-ossp`); fully
portable, zero vendor lock-in.
**Weaknesses:** no schema/migration tooling out of the box; more
hand-written boilerplate than the codebase's existing thin-adapter
style; weaker compile-time type inference without a query builder.
**Risks:** slower implementation velocity; migration discipline is
entirely manual.

### B. PostgreSQL + Drizzle

**Strengths:** everything in A, plus a thin, SQL-transparent query
builder with strong TypeScript inference and no code-generation step;
migrations are plain, reviewable SQL files (`drizzle-kit`); maps
almost 1:1 onto the existing `InMemory*Repository` method shapes;
doesn't fight per-transaction `SET LOCAL` session variables, which RLS
needs.
**Weaknesses:** younger ecosystem than Prisma; smaller community.
**Risks:** low — it is a thin layer over standard SQL, so the
"lock-in" surface is small even if abandoned later.

### C. PostgreSQL + Prisma

**Strengths:** best-in-class developer experience and documentation;
very strong generated-client type safety; large community.
**Weaknesses:** a second, parallel schema language (Prisma schema)
alongside SQL; Prisma's pooled client makes the per-request `SET
LOCAL` pattern RLS needs meaningfully clunkier (workable via raw
`$queryRaw`/`$transaction`, but it fights the abstraction rather than
working with it); heavier runtime than Drizzle; migration format is
Prisma-specific, less directly reviewable as SQL than Drizzle's.
**Risks:** moderate — RLS ergonomics are a known friction point in the
Prisma ecosystem and this system's isolation requirement is not
optional.

### D. Supabase-hosted PostgreSQL + Drizzle

**Strengths:** everything in B, plus managed backups, Point-in-Time
Recovery, connection pooling, and a hosting/ops story appropriate for
a small team at pilot stage; RLS is a first-class, dashboard-supported
concept in the Supabase ecosystem, not an add-on; free/low tier
appropriate for one design-partner clinic; `docs/03_PRD.md` and
`README.md` already name Supabase as the planned backend, and the
repository already carries an (empty) `supabase/` directory.
**Weaknesses:** managed-platform dependency for hosting (mitigated —
see Portability below); some superuser-level Postgres operations are
restricted on managed platforms.
**Risks:** low-to-moderate — mitigated because Supabase is vanilla
PostgreSQL underneath; nothing in this system's requirements needs a
Supabase-proprietary extension, so self-hosting later remains a
`pg_dump`/`pg_restore` away, not a rewrite.

### E. MySQL + a TypeScript ORM

**Strengths:** mature, widely hosted (RDS, PlanetScale), InnoDB gives
full ACID transactions and foreign keys comparable to Postgres for the
base relational case.
**Weaknesses:** **no native Row-Level Security** — tenant isolation
would have to be enforced through views, stored procedures, or an
application/proxy layer, which is a materially weaker structural
guarantee than what requirement 1 calls for; weaker extension
ecosystem for the encryption/retention tooling this system will need
as it matures toward clinical data.
**Risks:** the biggest single risk in the whole comparison — some
managed MySQL platforms (notably PlanetScale's Vitess-based product)
have historically not enforced foreign keys at all, which would
directly violate requirement 2 if that specific platform were chosen
without noticing.

---

## Decision Matrix

Weights are justified directly by the requirements list above, not
picked to favor an outcome: **organization isolation** is weighted
highest because the organization is explicitly the isolation root and
Section 7 of the DATA-W2 brief specifically demands a defense-in-depth
answer; **data integrity** next because the entire point of Layer 8 is
a correct governance audit chain; **healthcare evolution** and
**developer architecture** next because they shape how expensive
future work will be; **operations** and **current-stage practicality**
last because they matter but are the most reversible if wrong.

| Criterion (weight) | A: Postgres raw | B: Postgres+Drizzle | C: Postgres+Prisma | D: Supabase+Drizzle | E: MySQL+ORM |
|---|---|---|---|---|---|
| Organization isolation (25%) | 10 | 10 | 7 | 10 | 3 |
| Data integrity (20%) | 9 | 9 | 8 | 9 | 8 |
| Healthcare evolution (15%) | 9 | 9 | 8 | 8 | 5 |
| Developer architecture (15%) | 5 | 9 | 8 | 8 | 7 |
| Operations (15%) | 7 | 7 | 7 | 9 | 6 |
| Current-stage practicality (10%) | 6 | 8 | 7 | 9 | 6 |
| **Weighted score** | **80.5** | **88.5** | **75.0** | **89.5** | **56.5** |

MySQL (E) is disqualified primarily on organization isolation — no
native RLS is a direct conflict with a hard requirement, not a minor
deduction. Prisma (C) is a fully viable second choice, held back mainly
by RLS ergonomics. B and D are the same underlying technology
(PostgreSQL + Drizzle); D wins narrowly on operations/practicality
because it adds managed hosting without giving up anything B has —
**the proposed decision below composes B's engine/ORM choice with D's
hosting choice**, since the DATA-W2 brief itself asks for engine,
hosting, and ORM to be decided as separate axes (Section 14).

---

## Proposed Decision (Approved)

> **This decision is approved. Nothing below has been implemented yet
> in this session — no dependency has been installed, no infrastructure
> has been provisioned, no migration has been written. Implementation
> is DATA-W3's responsibility, not this document's.** Items 4
> (Migrations) and 7 (Audit immutability strategy) in the list below
> are subject to the amendment 7/8 validation carve-outs in "Approval &
> Amendments" — do not confuse this list's item numbers with the
> amendment numbers above them; they are different lists.

1. **Database engine:** PostgreSQL.
2. **Hosting approach:** Supabase-managed PostgreSQL (vanilla Postgres
   underneath — no proprietary extension dependency, so self-hosting
   remains a portable fallback, not a rewrite).
3. **TypeScript data-access/ORM approach:** Drizzle ORM, used as a thin
   query layer behind the *existing* `OrganizationRepository` /
   `GoalRepository` / `RecommendationRepository` interfaces and the
   *existing* `ApprovalRepository` port from `approval-governance` —
   the interfaces from DATA-W1/CMO-W2 are reused, not redesigned.
4. **Migration approach:** `drizzle-kit`-generated, plain-SQL,
   forward-only migration files, checked into version control and
   code-reviewed like any other change — consistent with this
   repository's existing "Architecture Before Code" / Documentation
   Driven Development culture (ARCH-003).
5. **Organization-isolation strategy:** **both** — Postgres Row-Level
   Security policies on every table (database-enforced, cannot be
   bypassed by a buggy query) **and** the already-proven
   organization-scoped repository method signatures from DATA-W1
   (`get(organizationId, id)`, never a bare `get(id)`). Neither alone
   is sufficient — see "Important Architecture Question" below.
6. **Transaction strategy:** a single database transaction wraps the
   terminal `ApprovalRequest` status update and the `ApprovalRecord`
   insert (see "Approval Atomicity" below); Drizzle's
   `db.transaction()` is the mechanism.
7. **Audit immutability strategy:** two-tier — database `REVOKE
   UPDATE, DELETE` on `approval_records` for the application role now;
   a `BEFORE UPDATE OR DELETE` trigger raising an exception as the
   stronger enterprise-grade addition once compliance maturity
   justifies it (see "Append-Only Audit" below).
8. **Local/test strategy:** keep the DATA-W1 in-memory repositories as
   the fast, dependency-free unit-test double for business logic
   (they remain valuable forever — they cannot verify RLS/trigger
   behavior, which is a real limitation, but they're not being
   replaced); add a smaller number of real-Postgres integration tests
   (local Supabase CLI stack, or an ephemeral test container) once the
   physical adapter exists, specifically to verify RLS and trigger
   enforcement that an in-memory double structurally cannot exercise.

---

## Conceptual Schema

> **Not selected — one of two options DATA-W3 must compare (amendment
> 8).** The composite `(organization_id, entity_id)` primary-key
> strategy below is a reference sketch, not an approved schema. It is
> explicitly NOT frozen as the universal pattern. DATA-W3 must compare
> it against globally unique entity IDs + `organization_id` + composite
> uniqueness / organization-aware foreign keys, and select whichever is
> the simplest design that preserves structural organization isolation
> and referential integrity — before any production migration.

No migrations are generated. Composite primary keys are proposed
throughout — `(organization_id, <entity>_id)` — because this makes
"every downstream record belongs to exactly one organization" a
structural property of the primary key itself, not just a convention,
and it makes every foreign key in the chain a **composite** foreign
key against a **composite** primary key, which is what makes
cross-organization references physically impossible to create rather
than merely application-checked.

```
organizations
  PK:  organization_id
  cols: organization_type, name, status, created_at, updated_at

goals
  PK:  (organization_id, goal_id)
  FK:  organization_id -> organizations(organization_id)
  cols: title, description, status, owner_executive, created_at, updated_at
  idx: (organization_id, status)

recommendations
  PK:  (organization_id, recommendation_id)
  FK:  (organization_id, goal_id) -> goals(organization_id, goal_id)
  cols: owning_executive, originating_skill, title, status,
        approval_requirement SMALLINT CHECK (1..5),
        risk, confidence SMALLINT CHECK (0..100),
        evidence_references JSONB, created_at
  idx: (organization_id, goal_id), (organization_id, status)

approval_requests
  PK:  (organization_id, approval_request_id)
  FK:  (organization_id, recommendation_id) -> recommendations(organization_id, recommendation_id)
  cols: goal_id, requested_by, required_approval_level SMALLINT CHECK (1..5),
        risk, reason, status
              CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
        created_at, expires_at, decided_at
  constraint: a trigger (or generated column + FK) asserting
        approval_requests.goal_id equals the goal_id of the referenced
        recommendation — a plain FK to goals alone cannot express
        "must match THIS recommendation's goal," only "must be some
        valid goal in this org"
  idx: (organization_id, recommendation_id), (organization_id, status),
       partial index on (expires_at) WHERE status = 'PENDING'

approval_records
  PK:  (organization_id, approval_record_id)
  FK:  (organization_id, approval_request_id) -> approval_requests(organization_id, approval_request_id)
  UNIQUE (organization_id, approval_request_id)   -- at most one terminal record per request, DB-enforced
  cols: goal_id, recommendation_id (denormalized — audit rows must be
        self-contained and reconstructable without a join),
        required_approval_level, decision
              CHECK (decision IN ('APPROVED','REJECTED','EXPIRED','CANCELLED')),
        approver_id, approver_role, rationale,
        requested_at, decided_at, previous_state, resulting_state
  grants: application role has INSERT, SELECT only — no UPDATE, no DELETE
```

The `UNIQUE (organization_id, approval_request_id)` on `approval_records`
is a hardening beyond what DATA-W1's in-memory version currently
guarantees: it makes "a request may receive at most one terminal
decision" a database-enforced invariant, catching even an application
bug that somehow called the append path twice.

---

## Approval Atomicity

`ApprovalGovernance.transitionAway()` (Session 2, unmodified) currently
calls `repository.updateRequestStatus(...)` and then
`repository.appendRecord(...)` as two separate calls. A physical
adapter must make these one database transaction:

```
BEGIN;
  UPDATE approval_requests
     SET status = $new_status, decided_at = $now
   WHERE organization_id = $org
     AND approval_request_id = $id
     AND status = 'PENDING';        -- optimistic guard, see below
  -- if 0 rows affected: ROLLBACK and surface "already decided"
  -- (closes a race DATA-W1's in-memory Map cannot protect against
  --  under real concurrent requests: two decide() calls interleaving
  --  between the read and the write)
  INSERT INTO approval_records (...) VALUES (...);
COMMIT;
```

**This requires one small, additive change to the `ApprovalRepository`
interface** in `approval-governance` — a single atomic method (e.g.
`recordDecision(request, record)`) replacing the two separate calls,
so the physical adapter can wrap both writes in one transaction without
the caller managing transaction boundaries. This is listed under
"Deferred Decisions" below — it is not implemented in this session, and
it is additive (Session 2's existing two-method shape can remain for
callers that don't need atomicity, or be deprecated cleanly), not a
breaking rewrite.

---

## Important Architecture Question — RLS vs. Application Scoping

**Decision: both, not either.** Application-layer organization-scoped
repository signatures (already built in DATA-W1) prevent *accidental*
cross-tenant queries in the normal application code path — cheap,
already done, good developer ergonomics. But they are trivially
bypassed by anything that doesn't go through those repository classes:
a future admin tool, an ad-hoc analytics script, a raw migration, a
bug in a new repository method that forgets the `WHERE organization_id
= ...` clause. Database-level Row-Level Security closes exactly that
gap — it is enforced by Postgres itself on every query regardless of
which code path issued it, as long as the connection's session
carries the correct organization context (`SET LOCAL app.current_org_id`
per request/transaction). Relying on application discipline alone
would directly contradict `docs/04_Architecture.md` Layer 8's own
requirement that isolation be enforced "at Database level ... Storage
level ... Audit level," not only in query-writing code.

---

## Append-Only Audit

> **Non-binding pending DATA-W3 (amendment 7).** Database-level
> immutability is an approved *requirement*; the specific mechanism
> below (permission revocation now, trigger later) is a recommendation,
> not a locked decision. DATA-W3 must validate the chosen mechanism
> specifically against the actual runtime database role the
> application connects as — e.g. a revoked `UPDATE` grant only
> protects the audit table if the application's own connection role is
> the one the grant was revoked from, not a superuser or migration
> role that bypasses it.

| Approach | Protects against | Cost |
|---|---|---|
| Application-only (today's DATA-W1 state) | Nothing outside the TypeScript layer | Free, already done |
| Database permissions (`REVOKE UPDATE, DELETE`) | The application's own DB role, even under a code bug | Cheap, one GRANT statement |
| Trigger-based (`BEFORE UPDATE OR DELETE RAISE EXCEPTION`) | Even elevated/superuser sessions, short of dropping the trigger itself (which is an auditable DDL event) | Small, standard Postgres feature |
| Immutable event-sourced ledger (state is a projection over an append-only event log, not stored mutably at all) | Architecturally purest guarantee | Materially higher build/query complexity |

**Recommended now:** database permission revocation — cheap, immediate,
meaningfully stronger than application-only.
**Recommended later (enterprise/compliance maturity):** add the
trigger. **Not recommended yet:** full event-sourcing — real
architectural value, but not justified at pilot scale; would be
over-engineering ahead of an actual compliance requirement.

---

## Healthcare Security Evolution (Clinical Data Boundary)

No `Patient`, `Encounter`, `Diagnosis`, `Prescription`, or
`MedicalRecord` table is designed here, matching `packages/data-foundation`'s
existing non-clinical scope. The proposed architecture supports a
future clinical boundary without redesigning what exists today:

- PostgreSQL schemas can separate concerns physically (e.g. a
  `clinical` schema with materially stricter grants than `public`)
  without moving the organization/goal/recommendation/approval tables.
- RLS policies for clinical tables would need a *stricter* predicate
  than the organizational tables here (e.g. requiring an explicit
  clinical-access role claim, not just organization membership) —
  the same RLS mechanism scales to a stricter policy, it does not need
  a different mechanism.
- `pgcrypto` (or column-level encryption, or transparent data
  encryption at the hosting layer) is available in the same engine
  when that boundary is actually built — not selected or configured
  now.
- None of this is designed in detail here; it is confirmed *possible*
  within the proposed engine, which is the only claim this ADR makes
  about healthcare data.

---

## Analytics Boundary

`docs/04_Architecture.md` Layer 8 itself distinguishes Transactional
Data from Analytical Data and states they "may use different storage
strategies in future versions." The proposed PostgreSQL instance is
recommended as the **transactional** store only. A dedicated analytics
warehouse is explicitly **not selected now** — at one design-partner
clinic, materialized views / read replicas on the same Postgres
instance are sufficient for Phase 1 reporting needs (Business Health
Score, Executive Dashboard). The boundary for later:

```
Transactional PostgreSQL (this ADR)
  -> governed domain events (RecommendationCreated, ApprovalRecorded, ...
     already named in docs/04_Architecture.md Layer 8 "Event Architecture")
  -> (future, not now) analytical store, decided only when reporting
     needs genuinely outgrow views on the OLTP database
```

---

## Consequences

- `packages/data-foundation`'s repository *interfaces* do not change.
  A physical `DrizzleOrganizationRepository` etc. implementing the same
  interfaces is additive, not a rewrite.
- `approval-governance`'s `ApprovalRepository` interface needs one
  additive method for atomic decision recording (see "Approval
  Atomicity") — a small, backward-compatible extension, deferred to
  implementation.
- A new `supabase/` and/or `drizzle/` directory structure will be
  needed at implementation time (not created in this session).
- CI will need a Postgres service (or local Supabase stack) for the
  new integration-test tier; the existing 31 in-memory-backed tests
  are unaffected and keep running without any database.

## Risks

- RLS policy bugs are a real risk class of their own (an incorrect
  policy can be *more* dangerous than none, by creating false
  confidence) — mitigated by the dual-layer strategy (RLS is
  defense-in-depth, not the only layer) and by the recommended
  integration-test tier specifically exercising cross-org access
  attempts against real RLS policies.
- Supabase, as a managed platform, is a third-party dependency for
  hosting — mitigated by the underlying engine being vanilla Postgres
  (portable) and by treating this as a hosting decision, separate
  from the engine decision, that could be revisited independently.
- Drizzle is a younger project than Prisma — mitigated by its
  thinness: the actual lock-in surface if it needed replacing later is
  small, since it doesn't own schema definition the way Prisma's
  schema language does.

## Security Boundary

Database-enforced RLS (organization isolation) + revoked
UPDATE/DELETE grants (audit immutability) + application-role least
privilege (the app's Postgres role should not itself be a superuser —
migrations run under a separate, more privileged role). No
authentication/authorization system is designed here (explicitly out
of scope for DATA-W1/DATA-W2); RLS policies will need a defined
mechanism for asserting "which organization is this connection acting
as," which becomes a dependency of a future auth session, not this one.

## Organization Isolation

Covered fully under "Important Architecture Question" above: both RLS
and application-scoped repository signatures, composite primary/foreign
keys throughout the schema.

## Migration Strategy

`drizzle-kit` SQL-diff migrations, forward-only, version-controlled,
code-reviewed. No destructive auto-migrations. Consistent with
`ARCH-003` (Architecture Before Code) — schema changes are documentation-
and-review-first, not generated-and-applied silently.

## Rollback / Portability

Because the proposed hosting (Supabase) is vanilla PostgreSQL with no
required proprietary extension for this system's needs, rollback from
"Supabase-hosted" to "self-hosted Postgres" is a standard
`pg_dump`/`pg_restore` or logical-replication migration, not an
application rewrite. Rollback from "Drizzle" to a different query
layer is likewise bounded, since Drizzle does not own the schema (the
SQL/migrations are the source of truth, not a Drizzle-specific format)
the way Prisma's schema language would.

## Deferred Decisions

Explicitly **not** decided by this ADR — left for implementation
sessions or future ADRs:

- The primary-key strategy itself (composite `(organization_id,
  entity_id)` vs. globally unique ID + organization-scoped uniqueness)
  — amendment 8 explicitly reopens this, DATA-W3 decides.
- The exact database-level immutability mechanism, validated against
  the actual runtime database role — amendment 7.
- The exact additive method signature for atomic approval-decision
  recording in `ApprovalRepository`.
- Authentication/session mechanism that supplies the RLS-scoping
  organization claim per request.
- Any clinical data model, schema, or encryption configuration.
- Any analytics warehouse technology.
- Exact Postgres version, region, and Supabase project tier.

---

## Decision Register

This ADR is **APPROVED** (with amendments — see "Approval &
Amendments" above), recorded as `ARCH-015` in `docs/11_Decisions.md`
on 03 September 2026 (the next sequential ARCH identifier — ARCH-001
through ARCH-014 are unchanged). The Decision Log entry is
intentionally terse and defers to this document for the full candidate
comparison, weighted decision matrix, conceptual schema, and deferred
decisions — it does not duplicate them.

Approval of this ADR is **not** approval of the exact primary-key
strategy (amendment 8 leaves this open) or the exact database-immutability
mechanism (amendment 7 leaves this open) sketched in "Conceptual Schema"
and "Append-Only Audit" below — those remain open for DATA-W3 to validate before any
production migration is written.
