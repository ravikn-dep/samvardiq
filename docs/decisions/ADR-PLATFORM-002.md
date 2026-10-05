# ADR-PLATFORM-002 — Durable Background Jobs and Scheduling

**Status:** APPROVED — Founder decision A2, approved with refinement (PLATFORM-INTEGRATIONS-W1, 2026-10-05). Recorded as `ARCH-021` in `docs/11_Decisions.md` (next identifier after `ARCH-020`, `ADR-PLATFORM-001`).

**Depends on:** `ADR-DATA-001` (`ARCH-015`), `ADR-IDENTITY-001` (`ARCH-016`), `ADR-IDENTITY-002` (`ARCH-019`, service principals), `ADR-PLATFORM-001` (`ARCH-020`, credentials never in payloads). Implements `docs/04_Architecture.md`'s "Job Queue" (priority, scheduled execution, retry, delay, concurrency control, dead-letter, cancellation, timeout, organization isolation), "Scheduling Engine", "Idempotency" and "Retry Logic" sections, which are canonical requirements with no implementation today.

**Implementation status:** not implemented. This ADR governs `PLATFORM-JOBS-W1`.

---

## Context

Verified against source (2026-10-05): the repository has **no job queue, worker or scheduler**. The only periodic need written so far — the 30-day purge of raw message content (`communication-orchestration/src/retention.ts`) — exists as a per-organization function whose cross-organization loop was explicitly never built (`CLINIC_W2_COMMUNICATION_ARCHITECTURE.md` §31). Google Business Profile needs daily, monthly and six-hourly synchronization; Google Analytics, Gmail, Meta and approved automation will need the same.

## Problem

Run work outside request handling so that it survives process restarts, deployments, worker crashes and transient provider failures; retries safely; never runs one organization's work with another organization's authority; and does not depend on a particular hosting platform.

## Decision

**A PostgreSQL-backed durable job queue with leases, plus a separate, idempotent schedule tick. At-least-once execution with idempotent effects — never a promise of exactly-once.**

### Job record (provider-neutral; final names in implementation)

job ID · job type · organization ID (null only for explicitly platform-global maintenance jobs) · payload (identifiers only, size-limited) · **idempotency key (unique)** · status · run-after time · attempt count · max attempts · lease owner · lease expiry · created / started / finished times · last failure class (sanitized code, never a message body).

**Payloads reference canonical records** (e.g. `{ connectionId, locationId, period }`), never data. **Credentials, tokens, patient or contact data, raw review text and message text are prohibited in payloads**; payload size is bounded by a database constraint.

### States and transitions

`PENDING → RUNNING → SUCCEEDED`
`RUNNING → RETRY_WAIT → RUNNING` (retryable failure, attempts remaining)
`RUNNING → DEAD` (terminal failure or attempts exhausted)
`RUNNING` with an expired lease is claimable again (crash recovery).

Transitions are performed only by the queue module's conditional updates (each checks the expected current state and, for completion, the lease owner); there is no general "set status" path. A database CHECK constrains the status values.

### Claim and lease

- Claiming selects due jobs (`PENDING`/`RETRY_WAIT` with run-after ≤ now, or `RUNNING` with an expired lease) using PostgreSQL row locking with `FOR UPDATE SKIP LOCKED`, and sets status `RUNNING`, a lease owner and a lease expiry in the same statement.
- **Fencing:** completion and failure updates require `lease_owner = me`. A worker whose lease expired and whose job was reclaimed cannot mark it succeeded or failed afterwards.
- Long jobs extend their lease (heartbeat) while running; a worker that stops heart-beating loses the job after expiry.
- No in-memory locks are relied on for correctness.

### Retries and failure classification

- The consumer classifies each failure: **retryable** (e.g. HTTP 429, timeout, provider outage) → `RETRY_WAIT` with exponential backoff and jitter until max attempts, then `DEAD`; **terminal** (invalid payload, permanent provider error) → `DEAD` immediately; **needs re-authorization** (revoked or invalid credential) → `DEAD` for this job and the owning connection set to `needs_reauth` (ADR-PLATFORM-001), so the scheduler stops creating jobs for it instead of retrying forever.
- Dead jobs are retained for inspection and pruned by age; they never re-run automatically.

### Delivery guarantee and idempotency

- **At-least-once.** A worker can crash after its external effect but before recording success; the job will run again.
- **Consumers must be idempotent.** The platform enforces a unique idempotency key at enqueue time (duplicate enqueue is a no-op), and every consumer's effects must be safe to repeat (e.g. upserts on natural keys). For GBP the key derives from job type + organization + location + sync type + reporting period.
- External actions with public side effects (future approved writes) additionally use the Automation Engine idempotency key already required by `04_Architecture.md` (organization + recommendation + approval + action + target + window).

### Scheduling

- **Schedule definitions are separate from execution.** Initially they live in code as a small registry (job type → cadence, e.g. GBP daily metrics, monthly keywords, six-hourly reviews), with cadence values configurable without code-architecture change. A database-backed schedule table is deferred until per-organization schedule editing is a real requirement.
- A **tick** evaluates the registry against eligible targets (e.g. active connections with bound locations) and **enqueues** due jobs with deterministic idempotency keys. Running the tick twice, late or concurrently creates no duplicates.
- **What invokes the tick and runs workers is a hosting detail** (initially a scheduled invocation and a worker process on the current host). Changing hosts changes only how the tick is triggered and where the worker runs, not job semantics.

### Tenant isolation and authority

- The job table is **platform-global operational data containing identifiers only** (same category as `webhook_event_dedup` and `communication_channels`): RLS enabled with a policy scoped to the runtime role, so a worker can claim across organizations without reading any tenant data.
- **Execution never borrows broad authority.** A job for organization Y runs under organization Y's context: tenant data is read and written through the existing `withOrganizationContext` / RLS path, and integration work runs as that organization's provisioned service principal resolved through the unmodified `AuthorizationService.resolveTrustedContext()` (ADR-IDENTITY-002). Before doing any work the consumer re-checks that the organization, the connection and any binding are still active; if not, the job ends without effect.
- No platform-administrator tenant access is introduced.

### Observability

Per job type and organization: queued, running, retry-waiting and dead counts; oldest due job; attempts; duration; last failure class; next scheduled run; expired leases. Never secrets, payload contents beyond identifiers, review text or clinical message content.

## Failure matrix

| Situation | Behaviour |
|---|---|
| Two workers claim at once | `SKIP LOCKED`: each job goes to one worker |
| Worker crashes before or during execution | Lease expires → job reclaimed → runs again (consumer idempotent) |
| External effect succeeded, crash before success recorded | Runs again; idempotent effects absorb it |
| Transaction rollback | Claim/complete are single statements; nothing half-recorded |
| Deployment / restart | Durable rows; leases expire; work resumes |
| Poison job | Bounded attempts → `DEAD` |
| Provider auth failure | `DEAD` + connection `needs_reauth`; scheduler stops scheduling it |
| Rate limit / timeout | Retry with backoff |
| Duplicate enqueue / tick runs twice | Unique idempotency key → no-op |
| Cross-organization access | Execution only under the job's organization context; RLS on all tenant data |
| Malicious, oversized or secret-bearing payload | Payload schema per job type validated before execution; size CHECK; identifiers-only rule tested |
| Dead-letter accumulation | Observable counts; age-based pruning |
| Scheduler temporarily unavailable | Next tick enqueues what is due; data marked stale until then |
| Database unavailable | Workers back off; nothing is lost |
| Organization disabled or connection revoked while queued | Pre-execution re-check ends the job without effect |

## Alternatives considered

1. **PostgreSQL-backed queue — CHOSEN.** Durable, transactional with Samvardiq's own data, uses existing infrastructure and RLS, testable against the same disposable PostgreSQL as every other integration test, no new vendor.
2. **Hosting-platform scheduled jobs only (e.g. cron triggering a script) — rejected as the queue.** No durable per-job state, retries, leases, dead-letter or idempotency; ties semantics to one host. Retained only as one possible *trigger* for the tick.
3. **External queue or workflow infrastructure (a hosted message queue, Redis-based queue, or a workflow engine such as Temporal) — rejected for now.** New infrastructure, operations and failure modes far beyond current needs; the job contract above can be moved onto one later without changing consumers.
4. **In-process timers in the API process — rejected.** Lost on every restart/deploy, duplicated across replicas, no durability.

## Consequences

- New platform module and one platform-global table (`PLATFORM-JOBS-W1`), with staging verifier inventory updates and schema-first deployment.
- A worker process and a tick trigger must be deployed on the current host alongside the API.
- Every consumer must document its idempotency key and failure classification; the retention purge loop and GBP sync become the first consumers.
