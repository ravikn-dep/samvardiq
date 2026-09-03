# SAMVARDIQ

## Data Persistence Requirements (Layer 8)

**Version:** 0.1 (draft input to DATA-W2)

**Status:** Draft — requirements only, no technology selected

**Owner:** Founder Office

---

## Purpose

This document records the requirements a future physical database must
satisfy to replace the in-memory reference repositories implemented in
`packages/data-foundation/` (DATA-W1 Session 3) without changing the
behavior those repositories already guarantee.

This is **not** a database selection document. No vendor, engine, or
product is recommended here. That decision belongs to a future session
(DATA-W2 — Physical Database Architecture & Technology Decision) with
this document as its input.

---

## Requirements

### Organization isolation

Every table/collection must carry an `organizationId` (or be reachable
only through a parent row that does) and every read/write path must be
scoped by it. `docs/04_Architecture.md` Layer 8 requires isolation
enforced "at Database level, API level, Service level, Query level,
Storage level, Audit level" — not application-code discipline alone.
The reference implementation enforces this by construction (compound
keys, org-scoped repository signatures); a physical database must
enforce the same thing structurally (e.g. row-level security, a
mandatory tenant column in every unique index), not just by convention
in query-writing code.

### Relational integrity

`Goal.organizationId` → `Organization`; `Recommendation.organizationId
= Goal.organizationId`; `ApprovalRequest.organizationId =
Recommendation.organizationId`; `ApprovalRecord.approvalRequestId` →
`ApprovalRequest`, with organization/goal/recommendation fields
matching. The reference implementation checks these at write time in
application code. A production database should be able to enforce the
core chain (foreign keys, or an equivalent constraint mechanism)
rather than relying solely on application checks.

### Transactions

Creating an `ApprovalRecord` and updating its `ApprovalRequest.status`
must be atomic — a future implementation must not be able to observe a
request stuck `PENDING` after its terminal record was already written,
or vice versa. Any physical implementation needs a transaction or
equivalent atomic-write guarantee around that pair.

### Append-only audit history

`ApprovalRecord` rows must never be updated or deleted once written —
enforced today by exposing no update/delete method on the repository
interface. A physical database should reinforce this independently of
application code (e.g. no UPDATE/DELETE grants on the audit table for
the application role, or an append-only storage engine/table design).

### Indexing requirements

Every organization-scoped lookup used today needs an efficient
equivalent: `(organizationId, goalId)` on Goal, `(organizationId,
recommendationId)` on Recommendation, `approvalRequestId` on
ApprovalRecord (for `listRecords`), and `(organizationId, approverId)`
on the approver directory. `listByOrganization` / `listByGoal` imply
`organizationId`-prefixed indexes, not full scans.

### Deterministic IDs

All identifiers in the reference implementation are caller-supplied or
`crypto.randomUUID()`-generated strings, never auto-incrementing
integers, and duplicate IDs are rejected rather than silently
overwriting (`DuplicateEntityError`). A physical database must
preserve both properties: ID collisions must be rejected, not
auto-resolved by overwrite, and IDs must remain stable/reproducible
identifiers rather than storage-assigned surrogate keys the
application doesn't control.

### Timestamps

`createdAt`/`updatedAt`/`requestedAt`/`decidedAt` are ISO-8601 strings
set once by the writing layer, never mutated after the fact (except
`Goal.updatedAt`, which is expected to change under controlled update
semantics — see Immutability below). A physical implementation should
preserve UTC ISO-8601 semantics and must not let storage-layer clocks
silently diverge from application-recorded decision times, since
`decidedAt` is itself audit-relevant.

### Migrations

Not evaluated in this session (no schema-migration tool is introduced
per scope). A physical implementation will need a forward-only
migration mechanism that can evolve the Organization/Goal/
Recommendation/Approval schema without breaking the referential-
integrity guarantees above, and ideally without a maintenance window
given the append-only audit requirement.

### Backup / recovery

Not evaluated in this session (no persistence survives a process
restart yet). A physical implementation's backup strategy must treat
the `ApprovalRecord` table as the system's audit-of-record — its
backup/recovery guarantees should be at least as strong as any other
table it depends on, since losing audit history after an approval was
already granted would itself be a governance failure.

### Encryption requirements

Not evaluated in this session (all data is process-local memory,
non-clinical). `docs/04_Architecture.md` Layer 8 "Data Classification"
already anticipates a "Sensitive" tier (credentials, personal contact
details, patient-related communication metadata) requiring "the
highest level of protection" — a physical implementation should
support encryption at rest and in transit at least for that tier, even
though nothing in this session's entities reaches it.

### Access control

Not evaluated in this session (no auth/session layer exists yet, out
of DATA-W1 scope). A physical implementation needs role-based access
enforced at the database layer, not only inside `ApprovalGovernance`'s
role-authority check — the same defense-in-depth reasoning that
already governs organization isolation above.

### Auditability

Beyond the `ApprovalRecord` chain already covered, `docs/04_Architecture.md`
Layer 8 "Audit Data" anticipates recording user/Executive/automation/
approval actions, data access, configuration changes, and security
events more broadly than approvals alone. A physical implementation
should have a general audit-event facility available to other Layer 8
consumers, not one built bespoke per entity type.

### Future healthcare data classification

This session explicitly created no `Patient`, `Encounter`, `Diagnosis`,
`Prescription`, or `MedicalRecord` entity, and no patient-identifiable
field exists anywhere in `packages/data-foundation/` (see
`test/persistence.test.ts` — no test fixture contains a patient field,
and `packages/marketing-intelligence`'s `enforceHealthcareDataBoundary`
already rejects such fields upstream of this layer entirely). When
clinical entities are eventually introduced, a physical database will
likely need a materially stricter classification, retention, and
access-control tier than the organizational/governance data covered by
this document — that is future work, not assumed here.

### Future retention / deletion policies

Not evaluated in this session. `docs/04_Architecture.md` Layer 8 "Data
Retention" and "Data Deletion" call for category-specific retention
periods, legal holds, and soft/permanent deletion workflows. None of
that is implemented yet — `Organization`/`Goal`/`Recommendation` here
have no expiry, and `ApprovalRecord` is explicitly meant to be kept
forever as audit history. A physical implementation will need to
decide retention per entity type before any deletion capability is
built.

### Future analytical / event workloads

`docs/04_Architecture.md` Layer 8 distinguishes Transactional Data
(Organization/Goal/Recommendation/Approval — what this session
covers) from Analytical Data (trends, comparisons, KPI history). This
session's reference repositories are transactional-shaped only (get/
list by key, no aggregation). A physical implementation should not
assume the same storage engine is the right fit for both workload
types without evaluating it explicitly in DATA-W2.

---

## Non-goals of this document

- Does not select PostgreSQL, MySQL, SQLite, Supabase, Prisma, Drizzle,
  or any other product.
- Does not specify a schema DDL.
- Does not size infrastructure or estimate cost.
- Does not decide row-level-security vs. application-level enforcement
  — it only requires that organization isolation be enforced somewhere
  structural, not merely in query-writing discipline.

---

## Status

Draft. Input to **DATA-W2 — Physical Database Architecture & Technology
Decision**. Not itself an architectural decision — no entry in
`docs/11_Decisions.md` is created by this document.
