# ADR-FRONTEND-001 — Samvardiq Web Client Architecture

**Status:** APPROVED — 2026-09-12, by the Founder. Recorded as
`ARCH-018` in `docs/11_Decisions.md`. Approval covers the framework
selection and the frontend-boundary invariants below, not a specific
code implementation — IDENTITY-W8 implements the minimum login/session/
organization-selection experience described here.

**Session:** IDENTITY-W8 (proposed and approved same session — one
candidate clearly fit existing architecture with no material conflict,
per that session's own authorization; see "Decision").

**Depends on:** `docs/decisions/ADR-HTTP-001.md` (`ARCH-017`),
`docs/decisions/ADR-IDENTITY-001.md` (`ARCH-016`), `apps/api/` (the
Fastify server this client is the first consumer of).

---

## Context

W2-W7 built a complete, tested identity/authorization/administration
backend with zero user-facing surface — every prior session's own
"Deferred Work" section named "login/session UI" as outstanding. W8's
objective is the first real browser experience, and no frontend
existed anywhere in this repository before this session (`apps/`
contained only `apps/api`; `design/` was empty; no root
`package.json`, no `node_modules` implying a JS frontend tool, no
framework reference anywhere in `docs/03_PRD.md` or
`docs/04_Architecture.md`). This is therefore a genuine, unmade
foundational decision — this ADR is that decision, following the exact
process ADR-HTTP-001 already established for exactly this class of
choice (compare candidates against the actual repository, do not adopt
the fashionable option, document the choice).

---

## Repository Discovery

- **Backend shape:** a separate Fastify HTTP API (`apps/api`,
  ARCH-017) already owns every piece of business logic, authentication,
  and authorization. The frontend's only job is presenting UI and
  calling that API — it holds no server-side logic of its own.
- **No SSR requirement:** every screen this session builds (login,
  organization selector, a minimal dashboard shell) sits behind
  authentication. There is no public, unauthenticated, SEO-relevant
  content anywhere in scope (W8 explicitly excludes a marketing site) —
  the strongest argument for SSR/server components does not apply.
- **Monorepo convention:** no root workspace tool exists; every package
  and app (`packages/*`, `apps/api`) is an independent `npm` project
  with its own `package.json`/`node_modules`, a deliberate choice
  ADR-HTTP-001 already made and this session does not revisit. A new
  `apps/web` follows the identical convention.
- **Toolchain:** Node 24, TypeScript throughout, ESM (`"type":
  "module"`) everywhere, no bundler anywhere in the existing backend
  (plain `tsc`). The frontend is the first place a browser bundler is
  genuinely required (browsers cannot run unbundled ESM+TypeScript
  source at the scale of a real app in the same way Node can).
- **Testing convention:** Node's built-in test runner (`node --test`)
  is used everywhere in the backend — no Jest anywhere. For a browser
  UI this is not directly reusable (no DOM, no component rendering
  story), so the frontend needs its own, but the SAME philosophy
  (minimal, fast, no unnecessary abstraction) governs the choice below.

---

## Candidates

Evaluated against the actual repository state above and current (2026)
package versions, not stale assumptions.

### A. React + Vite SPA

A client-only single-page app: React for components, Vite for dev
server/bundling, calling `apps/api` over `fetch`. Vite's dev server
supports fast HMR; its production build is static files deployable to
any host/CDN, independent of the API's own deployment — directly
matching ADR-HTTP-001's own "Deployment Portability" stance (no cloud
lock-in). No server runtime of its own — nothing to keep patched,
nothing that could accidentally grow a second copy of business logic
that belongs in `apps/api`. Official current versions:
`vite@8.3.0`, `react@19.3.0`, `react-dom@19.3.0` (checked live this
session via the public npm registry).

### B. Next.js

A React meta-framework with its own server (SSR, API routes, server
components, middleware). Every one of those capabilities either
duplicates what `apps/api` already does (API routes — a second HTTP
server would violate ARCH-017's dependency-direction rule in spirit,
inviting business logic to leak into the frontend's own server layer)
or answers a requirement this session does not have (SSR/SEO for
authenticated-only screens). Adopting it would mean either running an
unused server runtime for a purely client-rendered app, or actively
using SSR/API-routes and creating a second place authentication and
organization logic could be reimplemented — directly against section 6
of this session's own brief ("do NOT rebuild those boundaries").

### C. Vue / Svelte / Angular

Not evaluated to the full matrix — no prior use anywhere in this
repository or its documentation, and no requirement here that React
does not already satisfy. Introducing a second frontend ecosystem
convention with no offsetting benefit would be adopting a framework
because it exists, not because it fits — exactly what section 13 warns
against.

---

## Decision

**React + Vite is approved as Samvardiq's web client architecture** —
a client-only SPA in a new `apps/web` package, consuming `apps/api`
over `fetch`, with no server runtime of its own.

This is not a close call requiring a weighted matrix or Founder
tie-break: Next.js's differentiating capabilities (SSR, its own API
routes, server components) each either go unused or actively conflict
with an already-binding architectural rule (ARCH-017's dependency
direction; section 6/20/21's "do not rebuild the auth/authorization
boundary"). No candidate other than A and B was seriously in the
running for a TypeScript, React-shaped dashboard client.

---

## Frontend-Boundary Rules (Binding)

1. `apps/web` may call `apps/api` over HTTP only. It never imports
   from `packages/identity-access`, `packages/application-services`,
   or `packages/data-foundation`, and never talks to PostgreSQL or
   Supabase's database directly.
2. `apps/web` may use the official Supabase browser client
   (`@supabase/supabase-js`) for ONE purpose only: obtaining/refreshing
   a session and its access token. It never queries Supabase's database
   or storage, and the browser session it manages proves authentication
   only — it is never treated as organization authorization (ARCH-016,
   restated for this new consumer).
3. No component may construct, cache, or infer a
   `TrustedOrganizationContext`-shaped object. The only organization
   state the client holds is a UX-preference string
   (`lastSelectedOrganizationId`) and the plain discovery list from
   `GET /v1/me/organizations` — never a role-bearing authority object.
4. All backend calls funnel through one API client module — no
   component calls `fetch` directly against `apps/api`.
5. All Supabase browser calls funnel through one auth-client module —
   no component imports `@supabase/supabase-js` directly.

---

## Security Implications

- Bearer tokens are held only in the Supabase client's own managed
  session storage (its supported browser persistence) — never
  duplicated into a second, custom `localStorage` key, never logged,
  never placed in a URL.
- CORS: `apps/api`'s existing explicit-allowlist CORS (ARCH-017,
  section 26 of the W5 brief) is configured with the frontend's dev/
  prod origins — no wildcart, no change to the allowlist mechanism
  itself.
- No secret ever enters this app: the Supabase browser key is a
  publishable/anon key by Supabase's own design (safe for a browser
  bundle), and no service-role key is ever read by `apps/web` — see
  `.env.example` in that package for the exact, non-secret variables
  required.

---

## Testing

Vitest + `@testing-library/react` + `jsdom` (`vitest@5.0.0`,
`@testing-library/react@16.3.3`, `jsdom@30.0.1` — checked live this
session). Chosen over Jest because it shares Vite's own config/
transform pipeline (no second bundler configuration to maintain) and
is the standard pairing for a Vite-built React app; chosen over
snapshot-only testing because section 43 of this session's brief
explicitly requires behavior tests, not snapshots.

---

## Deployment Portability

A Vite production build is static HTML/JS/CSS — deployable to any
static host or CDN, entirely independent of how `apps/api` is deployed
(ARCH-017's own portability stance, extended here). W8 does not deploy
anything; this section documents the property the choice preserves,
not an action taken.

---

## Rejected Alternatives

- **Next.js** — capable, but its differentiating features are either
  unused (SSR/SEO, not needed behind auth) or would conflict with
  already-binding rules (a second API-route server duplicating
  `apps/api`'s job). See "Candidates" above for the full reasoning.
- **Vue / Svelte / Angular** — no existing convention, no requirement
  React does not already meet; rejected on "no reason to introduce a
  second frontend ecosystem," not on any technical deficiency.

---

## Consequences

- `apps/web` is added as a new, independent npm package, following the
  same per-package convention `apps/api` already established (no root
  workspace introduced).
- No backend package requires any code change to support this client —
  `apps/api`'s existing HTTP boundary (ARCH-017) and the new `GET
  /v1/me/organizations` discovery endpoint (this session) are consumed
  as-is.
- Future dashboard growth (CLINIC-W1 and beyond) extends `apps/web`
  incrementally; this ADR does not need revisiting unless an actual SSR
  or public-content requirement emerges.

---

## Future Review Triggers

- If a future requirement genuinely needs server-rendered, public,
  SEO-relevant content (e.g. a marketing site) that a static SPA cannot
  serve well, Next.js (or a dedicated separate marketing-site tool)
  becomes worth re-evaluating for THAT surface specifically — not a
  reason to migrate the authenticated dashboard.
- If `apps/web` grows enough server-side needs (e.g. its own
  server-rendered pages) that a client-only SPA becomes genuinely
  insufficient, revisit then, with the same "does this duplicate
  `apps/api`'s job" scrutiny applied.

---

## Founder Decision — APPROVED (2026-09-12)

**Approved:** React + Vite as Samvardiq's web client architecture, a
client-only SPA in `apps/web` with no server runtime of its own, and
the frontend-boundary rules above as binding constraints on all future
frontend code. Recorded as `ARCH-018` in `docs/11_Decisions.md`.

Approval covers the framework selection and its invariants, not a
specific code implementation — IDENTITY-W8 implements the minimum
login/session/organization-selection/dashboard-shell experience this
ADR describes.
