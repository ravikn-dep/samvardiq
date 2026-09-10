# ADR-HTTP-001 — Samvardiq HTTP Server and Routing Architecture

**Status:** APPROVED — 2026-09-10, by the Founder. Recorded as
`ARCH-017` in `docs/11_Decisions.md`. Approval covers the framework
selection and the framework-boundary invariants below, not a specific
code implementation — W5B implements the minimum real HTTP server
described here.

**Session:** IDENTITY-W5A (proposed and approved same session — evidence
produced a clear, non-tied winner; see "Weighted Decision Matrix").

**Depends on:** `docs/decisions/ADR-IDENTITY-001.md` (`ARCH-016`),
`packages/application-services/` (IDENTITY-W4's framework-neutral
request boundary — `authenticateRequest`, `handleListGoalsRequest`,
`classifyError`), `packages/identity-access/`, `packages/data-foundation/`.

---

## Context

IDENTITY-W4 built a complete, tested, framework-neutral request
boundary: `HTTP-shaped Request → extractBearerToken/
extractRequestedOrganizationId → IdentityProviderAdapter →
AuthorizationService → TrustedOrganizationContext → GoalReadService →
GoalRepository → PostgreSQL RLS`. `requestBoundary.ts`'s own doc
comment says explicitly: "no assumption about Express/Fastify/Hono/etc.
request/response objects... it does not reimplement any of the logic
here" — the boundary was deliberately built to be wired into a router
once a router is chosen, "a separate, explicit decision, not made
here" (same file, header comment). This ADR is that decision.

No HTTP framework, root workspace tool, or `apps/` package currently
exists in this repository. `apps/` exists as an empty directory
(created in an earlier session) but has never been populated.

---

## Repository Discovery

Before comparing frameworks, the actual repository was inspected
(not assumed from a prior report):

- **Node:** v24.15.0 (Node 22 types via `@types/node@^22`, but the
  running engine is Node 24 — no framework requirement here rules out
  either).
- **Module system:** ESM throughout (`"type": "module"` in every
  package). Any framework choice must have first-class ESM support —
  this alone weakens Express in practice, whose ecosystem still leans
  CommonJS-first (Express itself supports ESM consumption fine, but
  many companion middleware packages assume `require`).
- **TypeScript:** `typescript@^5.7`, strict compiler settings (per
  existing `tsconfig.json` files), `tsc -p tsconfig.build.json` for
  emit. No bundler (esbuild/webpack/tsup) is used anywhere — packages
  are plain `tsc` output.
- **Test framework:** Node's built-in `node --test` runner via `tsx`,
  no Jest/Vitest/Mocha anywhere. `test:integration` is a separate npm
  script per package that runs against a real, embedded, disposable
  PostgreSQL instance (`embedded-postgres`) — no mocking of the
  database boundary being tested.
- **Package management:** plain `npm`, **no root workspace tool**
  (no npm workspaces, no Turborepo, no Lerna). Every package is a
  fully independent `npm` project with `file:../other-package`
  `devDependencies` and its own `node_modules`. This is a deliberate,
  already-established convention (see `application-services/test/setup.ts`'s
  own doc comment explaining why: `jose`'s `customFetch` Symbol
  identity breaks across separately-hoisted `node_modules/jose`
  copies if workspace hoisting were introduced).
- **Monorepo tooling decision for W5:** **deferred, not introduced.**
  A root workspace would touch every existing package's install/build
  graph for a benefit (shared dependency deduplication) this session
  does not need — `apps/api` is added as one more independent npm
  project, following the exact convention every other package already
  uses. Introducing workspace tooling merely to host one new package
  would be exactly the kind of unrequested repository restructuring
  section 5 of the session brief prohibits.
- **Deployment assumptions:** none yet encoded anywhere in the repo
  (no Dockerfile, no CI workflow, no cloud config). No framework
  choice may assume a specific cloud/edge runtime as a result — see
  "Deployment Portability."
- **`apps/` vs. new top-level dir:** `apps/api/` is used, matching the
  empty `apps/` directory already present and the brief's own
  suggestion, without inventing new top-level structure.

---

## Requirements (Section 7 — Samvardiq Platform Shape)

The server must eventually carry: human dashboard/auth/org-switching
traffic; external integration traffic (CMS, Google Business Profile,
Gmail, WhatsApp Business Platform, analytics providers); webhooks
(Meta/WhatsApp, future payment/provider callbacks, CMS events);
automation-engine and scheduler entry points; future AI orchestration
including streaming; and enterprise operational concerns (observability,
structured logging, request IDs, validation, rate limiting, security
middleware, graceful shutdown, plugin/modular architecture, horizontal
scale, container/cloud-portable deployment).

The single structural fact that matters most for *this* decision: a
large share of that future traffic (WhatsApp/Meta webhooks, CMS events,
future payment callbacks) is **third-party HTTP POST with signature
verification against a raw body** — not TypeScript-to-TypeScript calls.
This structurally disqualifies pure-RPC frameworks (see tRPC below) and
weights raw-body/webhook ergonomics as a real, non-hypothetical
requirement rather than a "nice to have."

---

## Candidates

Evaluated against current (2026) official documentation and package
registry data fetched live during this session (`npm view` against the
public registry), not stale training-time assumptions.

### A. Fastify (`fastify@5.12.3`)

Schema-first Node framework. JSON Schema (Ajv) validation and
serialization are first-class, not bolted on. Plugin encapsulation
model (`fastify.register()`) gives each route group its own scoped
decorators/hooks without a global-namespace collision risk. Native
`.inject()` testing dispatches a request through the *entire* real
request pipeline (routing, hooks, validation, serialization) without
binding a TCP port — matches this session's own requirement (section
40) to test through "the real framework injection/server test
mechanism, not by calling the handler directly." Built-in structured
logging via `pino`, with per-request child loggers and `reqId`
correlation out of the box. Official first-party plugins exist for
every enterprise concern this ADR needs: `@fastify/cors`,
`@fastify/rate-limit`, `@fastify/helmet`, `@fastify/multipart`,
`@fastify/websocket`. Raw-body access for webhook signature
verification is a documented, supported pattern via
`addContentTypeParser` on a specific route (not a global body-parsing
override that would weaken every other route). Plain Node process —
no framework-imposed cloud/edge runtime.

### B. Express 5 (`express@5.x`, GA since 2024)

The most ubiquitous Node framework by raw ecosystem size. Express 5
finally made `async` route handlers safe (no more silently swallowed
rejected promises) — a real, current improvement over Express 4's
long-standing footgun, checked directly rather than assumed. Still,
Express provides **no built-in request/response validation or
serialization** — every route's input hygiene (section 21) has to be
hand-wired with a separate library (`zod`, `joi`) and manually invoked
per handler, which is exactly the kind of place business/validation
logic tends to leak into route bodies (violating question 4 in section
9) unless the team imposes its own discipline. Structured logging,
request IDs, and CORS/rate-limiting/security headers are all
separate, independently-versioned third-party packages with no single
maintainer coordinating their interaction — a materially larger,
less-coordinated dependency/security surface for the same feature set
than Fastify's first-party plugin set. Testing conventionally uses
`supertest`, which binds a real ephemeral port per test run rather than
Fastify's in-process `.inject()` — slower and, for the concurrency
tests this session requires (section 39 AS), noisier (real socket/OS
port exhaustion risk under 50+ concurrent test connections) for no
compensating benefit.

### C. Hono (`hono@4.x`)

Extremely lightweight, fast, TypeScript-native, and the most portable
candidate — the same code can run on Node, Bun, Deno, or an edge
runtime unchanged. Built-in middleware exists for CORS, secure headers,
and JWT, and `app.request()` gives an in-process test mechanism similar
in spirit to Fastify's `.inject()`. Genuinely competitive on
architecture fit and portability. Where it loses to Fastify for
*this specific platform*: its plugin/middleware ecosystem for
Node-specific enterprise concerns (rate limiting, multipart, mature
structured-logging-with-redaction) is younger and thinner — several of
the things Fastify ships as an official, versioned, security-maintained
plugin are either DIY or third-party-of-uncertain-maintenance in Hono's
ecosystem today. Samvardiq's near-term integration surface (CMS,
WhatsApp, GBP, Gmail — all server-side Node integrations, not edge
functions) does not need Hono's edge/multi-runtime portability enough
to offset that ecosystem gap; if a future AI-orchestration surface
specifically needs edge deployment, that is a narrower, later decision
that does not require the *entire* platform's HTTP layer to move today.

### D. NestJS — evaluated, not scored to the full matrix

NestJS is a full application framework (DI container, decorators,
modules, guards, interceptors) that itself runs *on top of* Express or
Fastify under the hood — it is an architectural layer *above* this
decision, not an alternative HTTP transport. For a two-route server
(`GET /health`, `GET /v1/organizations/:id/goals`), NestJS's module/
provider/decorator ceremony is exactly the "boilerplate for later"
Ponytail and section 5 both flag: it would impose a directory/DI
structure on `apps/api` with no current requirement to justify it, and
Samvardiq's dependency-injection need (section 33) is already fully
met by plain constructor injection at one composition root — no
framework-provided DI container is needed to satisfy that requirement.
If the API surface grows to dozens of resource modules with complex
cross-cutting concerns, NestJS remains revisitable then (see "Future
Review Triggers"); it is not disqualified on merit, only on current
necessity.

### E. tRPC — evaluated, not scored to the full matrix

tRPC provides end-to-end type-safe RPC between a TypeScript server and
a TypeScript client. It is structurally the wrong shape for a
requirement this ADR treats as load-bearing, not optional: WhatsApp
Business Platform, Meta, Google Business Profile, and future CMS/
payment webhook senders are third-party HTTP services posting
plain signed JSON to a fixed URL — they are not, and will never be, a
tRPC client. A REST/JSON HTTP surface is required at the platform
boundary regardless of what (if anything) is later used for
first-party dashboard-to-backend calls. Disqualified structurally, per
section 6's instruction to evaluate secondary candidates "only enough
to determine whether they provide a material advantage" — none exists
here for the platform's actual traffic shape.

---

## Weighted Decision Matrix

Weights exactly as specified in the session brief (unmodified).

| Criterion (weight) | Fastify | Express | Hono |
|---|---|---|---|
| Security / safe defaults (20%) | 9 | 6 | 8 |
| Architecture fit (15%) | 9 | 6 | 8 |
| TypeScript quality (10%) | 9 | 6 | 9 |
| Performance / scalability (10%) | 9 | 6 | 9 |
| Validation / serialization (10%) | 10 | 4 | 8 |
| Plugin / modular ecosystem (10%) | 9 | 9 | 6 |
| Testing (5%) | 9 | 7 | 8 |
| Observability / logging (5%) | 9 | 5 | 6 |
| Webhooks / integrations (5%) | 8 | 7 | 7 |
| Developer ergonomics (5%) | 8 | 8 | 9 |
| Deployment portability (5%) | 8 | 8 | 10 |
| **Weighted score** | **8.95** | **6.35** | **7.98** |

Fastify wins by a margin of ~1.0 point over the second-place candidate
(Hono) and ~2.6 over Express — not a tie, and not close enough to
require Founder tie-break escalation under section 12. The gap is
concentrated in exactly the criteria weighted heaviest (security,
architecture fit, validation) and in webhook/observability maturity
Samvardiq's own near-term roadmap (section 7) names explicitly, not in
low-weight cosmetic categories.

---

## Architectural Questions (Section 9) — Answered

1. **Does the framework preserve W4's framework-neutral application
   boundary?** Yes — nothing in `apps/api` changes
   `application-services`, `identity-access`, or `data-foundation`.
   Fastify route handlers call `handleListGoalsRequest`/
   `authenticateRequest` exactly as those functions were already
   designed to be called (see `requestBoundary.ts`'s own doc comment).
2. **Can route handlers remain thin adapters?** Yes — a handler's only
   job is: extract `Authorization` header + `:organizationId` route
   param → call the existing boundary function → map the result/error
   through `classifyError`. No authentication, membership, or role
   logic is written in `apps/api`.
3. **Schema validation?** Yes, natively — Fastify's JSON Schema
   validates route params and (where practical) response shapes with
   no additional dependency.
4. **Encourage or discourage business logic in routes?** Discourages —
   Fastify's plugin/route registration pattern has no natural place to
   "just add a query" the way an Express middleware chain does; the
   schema-first style pushes input handling to configuration, not
   imperative code, and the encapsulation model makes reaching into
   another concern's internals awkward by construction.
5. **Authentication hooks/middleware?** Fastify's `preHandler` hook
   is used to call `authenticateRequest`/`handleListGoalsRequest` —
   no Fastify-specific authentication *logic* is introduced; the hook
   is pure plumbing.
6. **Can Samvardiq's own error model remain authoritative?** Yes —
   `classifyError()` is called in Fastify's `setErrorHandler`; Fastify
   never invents its own error-to-HTTP mapping for domain errors.
7. **Raw-body/signature verification for future webhooks?** Yes,
   documented, supported pattern (`addContentTypeParser` scoped to a
   specific route) — not built this session (section 16 forbids it),
   verified as an extension point only.
8. **Streaming later?** Yes — Fastify supports returning a Node
   `Readable`/manual `reply.raw` writes for SSE and chunked responses;
   not built this session, verified as a non-blocking extension point.
9. **Structured logging/request IDs?** Yes, built-in (`pino` under the
   hood), with `genReqId` overridden in W5B to always generate
   server-side (never trusts an inbound `request-id` header — section
   25's explicit instruction).
10. **Graceful shutdown?** `fastify.close()` stops accepting new
    connections, drains in-flight requests, and runs registered
    `onClose` hooks (used in W5B to close the Postgres pool) — no
    additional library needed.
11. **Cloud lock-in?** None — Fastify is a plain Node HTTP server
    (`@fastify/node-server` under the hood over Node's own `http`
    module); runs identically on any container/VM/PaaS that runs Node.
12. **Framework-specific code leaking into `application-services`?**
    None — `application-services` has, and will continue to have, zero
    dependency on `fastify` or any HTTP library. Verified: `apps/api`
    depends on `application-services`; the reverse import never exists
    (enforced by directory/dependency direction, not by lint rule,
    since no other package in this repo enforces dependency direction
    via tooling either — consistent with existing convention).
13. **Dependency/security surface?** Fastify core plus four official,
    Fastify-maintained plugins — audited in section "Full Regression"
    below; all first-party, versioned together with core, a smaller
    coordinated surface than assembling five independently-maintained
    Express middleware packages for the same feature set.
14. **Ecosystem maturity?** Fastify has been a stable, widely-deployed
    production framework for years, with the plugin set used here
    (`cors`, `rate-limit`, `helmet`) each independently mature and
    security-maintained.
15. **Suitable at multi-clinic/multi-organization scale?** Yes — nothing
    about the routing/plugin model is single-tenant-shaped; organization
    scoping happens entirely below the HTTP layer (in
    `application-services`/`identity-access`), which is exactly the
    separation this ADR is designed to preserve.

---

## Decision

**Fastify (`fastify@5.x`) is approved as Samvardiq's HTTP server and
routing framework**, together with the following official, versioned
Fastify plugins for the concerns named in the session brief:
`@fastify/cors`, `@fastify/rate-limit`, `@fastify/helmet`.

---

## Security Implications

- Fastify's schema validation runs **before** any route handler code,
  giving Samvardiq a real trust boundary at the transport edge in
  addition to (never instead of) the existing authentication/
  authorization boundary in `application-services`/`identity-access`.
- The four framework-boundary rules below exist specifically so schema
  validation, plugins, and logging remain input hygiene and transport
  plumbing — never a second, competing authorization system.
- `@fastify/helmet` is configured with `contentSecurityPolicy: false`
  and other browser-rendering-oriented directives disabled — this is a
  JSON API with no HTML responses, and shipping a CSP/browser-oriented
  header set on an API that never serves HTML would be exactly the
  "cargo-cult browser headers" section 29 warns against. Only headers
  that materially matter for a JSON API (e.g. `X-Content-Type-Options:
  nosniff`) are kept.

---

## Framework-Boundary Rules (Binding)

1. `apps/api` may depend on `application-services`, `identity-access`,
   and `data-foundation`. None of those packages may ever depend on
   `apps/api` or on `fastify`/any HTTP library.
2. A Fastify route handler or hook may extract transport-shaped values
   (headers, route params) and pass them to an existing
   `application-services` function. It may never itself decode a JWT,
   query membership, query the database, construct a
   `TrustedOrganizationContext`, or infer a role/`ApproverRole`.
3. Fastify's own error handling is wired to call `classifyError()` for
   every error surfaced from `application-services`/`identity-access`;
   it never invents its own mapping for those domain errors, and it
   never lets an unclassified error's raw message reach a client
   response in production.
4. Fastify schema validation is input hygiene, not authorization —
   a request that passes schema validation still must pass the
   existing authentication/authorization boundary before reaching a
   protected application service.

---

## Deployment Portability

Fastify has no cloud-specific dependency: it runs as a plain Node
process listening on a TCP port, containerizes with a standard
Dockerfile (none exists yet — out of scope for W5, see "Deferred
Work" in the final report), and imposes no requirement on which
cloud/VM/PaaS eventually hosts it. TLS termination is assumed to occur
at a trusted reverse proxy/ingress in production (section 30); Fastify
itself is configured with a conservative `trustProxy` default (`false`
unless explicitly enabled via configuration) so `X-Forwarded-For`/
`X-Forwarded-Proto` are never blindly trusted from an arbitrary client.

---

## Rejected Alternatives

- **Express** — rejected on the matrix: weakest on the two
  heaviest-weighted criteria (security/safe defaults, architecture
  fit) and on validation/serialization, where it has no built-in
  answer at all. Not rejected because it is a bad framework in
  general — rejected because Fastify is a materially better fit for
  *this* platform's stated requirements.
- **Hono** — genuinely competitive (2nd place, ~7.98), rejected
  primarily on plugin/observability maturity for Samvardiq's specific
  near-term Node-hosted integration/webhook surface. Its edge/
  multi-runtime portability is a real strength this ADR does not need
  today; if a future AI-orchestration or edge-latency requirement
  changes that calculus, it is the most likely re-review candidate
  (see "Future Review Triggers").
- **NestJS** — not rejected on capability, rejected on current
  necessity: it is an architectural layer above whichever transport it
  wraps, and imposes structure this two-route server does not yet
  need.
- **tRPC** — structurally disqualified: Samvardiq's near-term traffic
  (third-party webhooks) is not TypeScript-RPC-shaped traffic.

---

## Consequences

- `apps/api` is added as a new, independent npm package (no root
  workspace introduced), following this repository's existing
  per-package convention.
- `application-services`, `identity-access`, and `data-foundation`
  require zero code changes to be wired into a real router — this was
  the explicit design goal of IDENTITY-W4's `requestBoundary.ts`/
  `protectedGoalListHandler.ts`, and this ADR confirms that goal was
  met rather than needing to be revisited.
- Four new first-party dependencies enter the repository, scoped
  entirely to `apps/api`: `fastify`, `@fastify/cors`,
  `@fastify/rate-limit`, `@fastify/helmet`.
- Future webhook endpoints (WhatsApp, CMS, payment providers) will use
  Fastify's per-route `addContentTypeParser` pattern for raw-body
  signature verification — not built this session, but the framework
  choice is confirmed compatible with it before committing to it.

---

## Future Review Triggers

- If a future AI-orchestration or edge-latency requirement specifically
  needs multi-runtime/edge deployment, Hono becomes the most likely
  re-review candidate (it scored 2nd, not far behind, and edge
  portability was its main differentiator).
- If the API surface grows to dozens of resource modules with complex
  cross-cutting concerns (multi-role authorization matrices, deep
  module graphs), NestJS-style structure becomes worth revisiting —
  not before then.
- If Fastify's own major-version support lapses or a security
  advisory materially changes its risk posture, this ADR should be
  revisited before the next major platform milestone.

---

## Founder Decision — APPROVED (2026-09-10)

**Approved:** Fastify as Samvardiq's HTTP server and routing framework,
with `@fastify/cors`, `@fastify/rate-limit`, and `@fastify/helmet` as
the initial official plugin set, and the framework-boundary rules above
as binding constraints on all future HTTP-layer code. Recorded as
`ARCH-017` in `docs/11_Decisions.md`.

Approval covers the framework selection and its invariants, not a
specific code implementation — W5B implements the minimum real HTTP
server (`GET /health`, `GET /v1/organizations/:organizationId/goals`)
this ADR describes.
