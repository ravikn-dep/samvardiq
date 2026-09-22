# Supabase Staging Migration Runbook

**STATUS: EXECUTED ON `samvardiq-staging` (INFRA-W1B 2026-09-21, INFRA-W1C 2026-09-22).** §§1–18 were written by INFRA-W1A (discovery/audit only) and have been corrected where W1B's execution against the real Supabase project disproved them — most importantly §7 (Supabase was **not** free of incompatibilities; see §19, findings F1/F2, and §20, findings F3/F4). §19 is the W1B execution record; §20 is the W1C privilege-surface-hardening record. No secret value appears anywhere in this document.

**Depends on:** `ADR-DATA-001` (Supabase-managed PostgreSQL approved as hosting, `ARCH` decisions register), `ADR-IDENTITY-001`/`ADR-IDENTITY-002`. Samvardiq checkpoint at the start of INFRA-W1B: `7b74bf60baf19019bc1ed25daa1ae2e7aced3f27`.

---

## 1. Purpose

Define the exact, safe procedure for applying Samvardiq's four canonical PostgreSQL migration chains to the empty `samvardiq-staging` Supabase project, and the verification gates that must pass before staging is considered usable. This document was the W1B execution guide (W1A performed no remote action); W1B executed it — see §19.

## 2. Architecture Recap

Four packages independently own PostgreSQL schema, each via Drizzle-generated + hand-written SQL migrations, all targeting the `public` schema of ONE physical database:

- `data-foundation`: organizations, goals, recommendations, approval_requests, approval_records.
- `identity-access`: identities, identity_provider_links, organization_memberships, identity_audit_events.
- `clinic-cms-connector`: clinic_cms_connections, clinic_cms_connector_evidence.
- `communication-orchestration`: communication_channels, conversations, communication_messages, communication_message_content, webhook_event_dedup.

All four share one runtime role, `samvardiq_app` (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`), created idempotently by whichever package's migration runs first. All tenant-scoped tables use Row Level Security keyed on `current_setting('app.current_org_id', true)`, set per-transaction via `set_config('app.current_org_id', $1, true)`. `identity-access` additionally uses a second GUC, `app.current_identity_id`, for the membership self-discovery read path.

## 3. RESOLVED — Migration Journal Sharing Risk (found and fixed during W1A)

Every package called `migrate(db, { migrationsFolder })` from `drizzle-orm/node-postgres/migrator` with no `migrationsSchema`/`migrationsTable` override. Reading the installed driver's source (`node_modules/drizzle-orm/pg-core/dialect.js`) showed the migrator does **not** track a per-migration hash set — it tracks a single global watermark: `select ... from drizzle.__drizzle_migrations order by created_at desc limit 1`, then applies a local migration only if its own generation timestamp (`folderMillis`, from `meta/_journal.json`) exceeds that one watermark row. Because none of the four packages overrode the schema/table name, **all four shared one physical `drizzle.__drizzle_migrations` table with no per-package scoping.**

**Empirically proven** (local embedded-Postgres proof, this session, never touched Supabase):
- Running all four packages' migrators against one shared database in dependency order succeeded completely: 16 tables, 12 recorded migrations, one `samvardiq_app` role, idempotent on a second run.
- Running `communication-orchestration` (the package with the *latest* migration-generation timestamps) **first**, then the other three, caused the other three packages' migrations — 11 of 16 tables, including all of `data-foundation`'s and `identity-access`'s roles/RLS/triggers — to be **silently skipped, with no error**, because their timestamps fell below the watermark `communication-orchestration` had just set.

This was a **pre-existing repository defect in the migration runner**, not a Supabase-specific incompatibility — it would have manifested identically against any shared PostgreSQL database, self-hosted or managed. It was safe only by coincidence: the four packages' migration-generation timestamps happened to already be globally monotonic in the same order the dependency graph requires, with no enforcement of that fact.

**Fix applied and verified this session** (Founder-approved): each package's `runMigrations()` now passes its own `migrationsSchema` — `drizzle_data_foundation`, `drizzle_identity_access`, `drizzle_clinic_cms_connector`, `drizzle_communication_orchestration` — to `migrate()`. One additive line per package's `src/postgres/client.ts`; no table, role, or RLS policy changed. Re-ran the exact same reverse-order local proof that previously demonstrated the bug: all 16 tables now created correctly regardless of run order, 4 distinct journal schemas, exactly one `samvardiq_app` role, idempotent on rerun. Full repository regression suite (unit + integration, all affected packages) re-run afterward with identical counts to baseline — see the INFRA-W1A final report. Migration order (§5) is no longer safety-critical for this reason; it remains the recommended order for clarity and because dependency-free packages still benefit from a stable, documented sequence.

## 4. No New ADR / No Architecture Conflict

ADR-DATA-001 already approves Supabase-managed PostgreSQL, already names "some superuser-level Postgres operations are restricted on managed platforms" as an accepted, anticipated weakness, and already commits to vanilla-Postgres portability. Every migration in this repository uses only standard DDL/DCL Supabase's documented `postgres` role supports (`CREATE ROLE`, `GRANT`/`REVOKE`, `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `CREATE FUNCTION`/`CREATE TRIGGER`, standard indexes/constraints). Zero PostgreSQL extensions are required anywhere in this codebase. No new ADR is required for this deployment — but note §7/§19: standard DDL/DCL working is **not** the same as Supabase's platform behaviour being neutral; two platform behaviours (F1/F2) needed a hardening step. Neither is an architecture conflict (nor was the migration-journal-sharing defect in §3, a repository code-quality/safety issue).

## 5. Canonical Migration Dependency Order

No physical foreign key crosses a package boundary (deliberately — `organization_memberships.organization_id` has no FK into `data-foundation`'s `organizations` table; cross-package consistency is enforced at the application layer by `resolveOrganizationAccess`). The order below is therefore driven by (a) the shared-role/shared-journal-watermark safety requirement in §3, and (b) each package's own internal migration sequence, which is strictly ordered by its own journal:

| Order | Package | Migration | Objects Created/Changed | Dependencies | Privilege Needed |
|---|---|---|---|---|---|
| 1 | data-foundation | `0000_stormy_slapstick` | organizations, goals, recommendations, approval_requests, approval_records + FKs + indexes | none | DDL (CREATE TABLE, FK, INDEX) |
| 2 | data-foundation | `0001_rls_and_roles` | `samvardiq_app` role (idempotent), GRANTs, RLS+FORCE RLS+policies on all 5 tables, `enforce_approval_request_goal_consistency` fn+trigger, `prevent_approval_record_mutation` fn+trigger | #1 | CREATE ROLE, GRANT, ALTER TABLE, CREATE POLICY, CREATE FUNCTION, CREATE TRIGGER |
| 3 | identity-access | `0000_messy_the_fury` | identities, identity_provider_links, organization_memberships + FKs | none | DDL |
| 4 | identity-access | `0001_rls_membership_and_role` | `samvardiq_app` role (idempotent no-op after #2), GRANTs on identities/identity_provider_links/organization_memberships, RLS+FORCE RLS+policy on organization_memberships | #3 | CREATE ROLE (no-op), GRANT, ALTER TABLE, CREATE POLICY |
| 5 | identity-access | `0002_sour_terrax` | identity_audit_events + FK to identities | #3 | DDL |
| 6 | identity-access | `0003_identity_audit_events_security` | GRANT on identity_audit_events, RLS+FORCE RLS+dual-scope policy, `prevent_identity_audit_event_mutation` fn+trigger, 4 indexes | #5 | GRANT, ALTER TABLE, CREATE POLICY, CREATE FUNCTION, CREATE TRIGGER, CREATE INDEX |
| 7 | identity-access | `0004_membership_self_discovery` | DROP+replace organization_memberships' single policy with 3 command-specific policies (INSERT/UPDATE unchanged, SELECT widened for self-discovery only) | #4 | DROP POLICY, CREATE POLICY |
| 8 | clinic-cms-connector | `0000_thin_raider` | clinic_cms_connections, clinic_cms_connector_evidence | none | DDL |
| 9 | clinic-cms-connector | `0001_rls_and_roles` | `samvardiq_app` role (idempotent no-op), GRANTs, RLS+FORCE RLS+policies on both tables | #8 | CREATE ROLE (no-op), GRANT, ALTER TABLE, CREATE POLICY |
| 10 | clinic-cms-connector | `0002_connector_evidence_actor` | ADD COLUMN actor_identity_id/actor_principal_type + CHECK constraint on clinic_cms_connector_evidence | #8 | ALTER TABLE |
| 11 | communication-orchestration | `0000_communication_tables` | communication_channels, conversations, communication_messages, communication_message_content, webhook_event_dedup | none | DDL |
| 12 | communication-orchestration | `0001_rls_and_roles` | `samvardiq_app` role (idempotent no-op), GRANTs, RLS+FORCE RLS+policies on conversations/communication_messages/communication_message_content (channels + dedup deliberately have none — see §7) | #11 | CREATE ROLE (no-op), GRANT, ALTER TABLE, CREATE POLICY |

`application-services` owns no database object — pure orchestration, no migration.

## 6. Shared Database Objects

| Object | Created by (first runner in order above) | Re-declared (idempotent no-op) by |
|---|---|---|
| Role `samvardiq_app` | data-foundation `0001` | identity-access `0001`, clinic-cms-connector `0001`, communication-orchestration `0001` — each guarded by `IF NOT EXISTS (SELECT 1 FROM pg_roles ...)`, verified safe by the local proof (exactly one role exists after all four run) |
| Schema `public` | pre-existing (Postgres default / Supabase default) | all — no package creates or assumes any other schema |
| Migration journal schemas | each package now owns its own (`drizzle_data_foundation`, `drizzle_identity_access`, `drizzle_clinic_cms_connector`, `drizzle_communication_orchestration`) since the §3 fix | — no longer shared |
| Postgres extensions | none required by any package | — |

No two packages independently assume ownership of the same table, function, trigger, or (after the §3 fix) migration journal.

## 7. Supabase Compatibility

> **CORRECTION (INFRA-W1B).** The INFRA-W1A version of this section concluded there was no incompatibility. That was **false** for two Supabase-platform behaviours a local vanilla-PostgreSQL proof cannot show (F1, F2 — §19.3). The migrations themselves apply cleanly; the platform's automatic behaviour around them did not match the schema's intent until the hardening step described in §19.3 was added.

- **PostgreSQL version:** staging runs PostgreSQL 17.6. No migration uses a version-specific feature.
- **Admin role reality (verified):** Supabase's `postgres` connection role is **not** a superuser (`rolsuper = false`) but has `rolcreaterole = true` and **`rolbypassrls = true`**. Every `CREATE ROLE samvardiq_app ... NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION` succeeded. Consequence for §14: RLS can **never** be tested as the admin role — it bypasses RLS. Tenant-isolation proofs must run as `samvardiq_app` (`SET ROLE`, §19.4).
- **Role membership reality (verified):** `postgres` holds a pre-existing membership in `samvardiq_app` granted by `supabase_admin` with ADMIN OPTION but **without SET**, so `postgres` cannot `SET ROLE samvardiq_app` by default. This edge is platform provisioning and must not be removed (it is what lets `postgres` administer the role, e.g. provision its password later).
- **Grants/revokes, functions/triggers, FORCE RLS, extensions, schema assumptions:** as in W1A — all applied and verified; no extension needed; all functions `SECURITY INVOKER`; everything lives in `public`; no coupling to `auth`.
- **Supabase `ensure_rls` event trigger (F1):** every `CREATE TABLE` in `public` is followed by an automatic `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. The four platform-global tables (§19.3) are deliberately created without RLS, so they became RLS-enabled with **zero policies = deny-all for `samvardiq_app`**.
- **Supabase default privileges (F2):** `anon`, `authenticated` and `service_role` receive full privileges on every new `public` table/sequence/function, and new functions are additionally executable by PUBLIC.
- **Supabase Auth coupling:** none required now, and none should be added. Samvardiq verifies Supabase-issued JWTs against the project's public JWKS endpoint (`SUPABASE_PROJECT_URL`, not a secret) and maintains its own `identities`/`organization_memberships` tables entirely independently of `auth.users`. No foreign key, trigger, or view ever references the `auth` schema.

## 8. Connection Strategy

### Migration/admin connection
Needs `CREATE ROLE`, `GRANT`, DDL, trigger/function creation, and multi-statement transactional DDL — all of which require session-level behavior (a stable backend connection for the duration of a migration run, not per-statement multiplexing).

- **Supabase's own current documentation is explicit:** transaction-mode pooling (Supavisor, port 6543) does not support session-level features such as `SET` statements outside a single transaction and is documented as intended for many short-lived serverless/edge connections — not for administrative/DDL sessions.
- **Decision:** never use Transaction Pooler for migrations.
- **If the migration-running environment has IPv6 connectivity:** use the Direct Connection (port 5432, IPv6 by default) — the simplest, most standard option, a true single persistent session.
- **If it does not:** use the Session Pooler (Supabase's documented IPv4-compatible alternative to a direct connection) — it behaves as a real session (one backend connection per client session, not per-transaction), so `CREATE ROLE`/DDL/multi-statement transactions behave identically to a direct connection.
- **Paid dedicated IPv4 add-on: not justified.** The free Session Pooler already solves the IPv4 case for both migration and (if desired) runtime traffic; there is no discovered requirement only a dedicated IPv4 address could satisfy.

### Runtime application connection (`apps/api`, for W1B planning only — not deployed in W1A)
`withOrganizationContext`/`withIdentityContext` call `set_config('app.current_org_id'/'app.current_identity_id', $1, true)` (`is_local = true`, i.e. `SET LOCAL` semantics) and always run the dependent query inside the **same** `db.transaction(...)` block as the `set_config` call. Current Supabase documentation on this exact pattern confirms it is safe under transaction-mode pooling: a `SET LOCAL`/`set_config(..., true)` value is reverted by Postgres itself at commit/rollback, before the pooler could ever hand that backend connection to a different client — so no cross-tenant GUC leakage is possible regardless of pooling mode.

That said, `apps/api` is a persistent Fastify server using a long-lived `pg.Pool` (not a serverless/edge function opening many short-lived connections) — exactly the workload Supabase's own docs describe Direct Connection as suited for ("persistent backends, such as virtual machines and long-running containers"), while Transaction Pooler's stated benefit (handling many short-lived connections) doesn't apply here. **Recommendation for W1B:** Direct Connection (or Session Pooler, if IPv6 is unavailable in the deployment environment) for the runtime connection too — not Transaction Pooler. Transaction Pooler remains a documented-safe fallback if connection-count limits ever require it later, but is not the default recommendation for this workload shape. This is a recommendation only; no runtime connection is established in W1A.

## 9. Environment Variables (names only — no values, ever)

Existing convention (already established, unchanged by this document):
- `DATABASE_URL` — the **runtime**, `samvardiq_app`-scoped connection string, read by `createPostgresClient()` in all four packages when no explicit config is passed.
- `SUPABASE_PROJECT_URL` — the Supabase project's public URL (not a secret; used only to derive the public JWKS endpoint for JWT verification).
- `META_WHATSAPP_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` — WhatsApp-specific, unrelated to this migration.
- Per-connection `env:<NAME>` secret references resolved dynamically by `EnvConnectorSecretProvider` (CMS/access-token secrets) — not fixed names.

**Gap found (§3 of the W1A brief):** there is currently no separate variable for an **admin/migration** connection — `DATABASE_URL`'s own `.env.example` value already shows a `samvardiq_app`-scoped example, confirming it was never intended to carry admin credentials. **`MIGRATION_DATABASE_URL` (implemented by W1B)** — the admin/owner connection string, read only by `apps/api/scripts/*` (the runner and the verifier), kept separate from `DATABASE_URL` at every point. A second, independent gate `SAMVARDIQ_DEPLOY_ENV=staging` must also be set, and the runner refuses unless the pooler username matches the intended staging project. Neither value is ever printed.

## 10. Secret Handling

- `.gitignore` already excludes `.env` and `.env.*`, with an explicit `!.env.example` exception — confirmed correct, unchanged.
- No `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, or `SUPABASE_JWT_SECRET` is read anywhere in this codebase — Samvardiq's backend never needs a service-role key; `apps/web` uses only the publishable (anon) key, which Supabase itself documents as safe to ship in a browser bundle.
- For W1B, the Founder provides `MIGRATION_DATABASE_URL` and (if rotated) `DATABASE_URL`/`SUPABASE_PROJECT_URL` **locally**, via their own shell environment or a local, gitignored `.env` file copied from the relevant `.env.example` — never pasted into a chat/prompt with an AI assistant, consistent with this session's own operating constraint.

## 11. Migration Execution Commands (implemented in W1B)

Run from `apps/api/` (the only place in this repository where all four PostgreSQL-owning packages are installed dependencies; there is no root workspace), with `SAMVARDIQ_DEPLOY_ENV=staging` and `MIGRATION_DATABASE_URL` (Session Pooler, port 5432) set in your own shell — never pasted into a chat/prompt:

| Step | Command | Mutates DB | Notes |
|---|---|---|---|
| Migrate + harden | `npm run migrate:staging` (builds the package `dist`s first via `premigrate:staging`) | Yes | Migrates the four packages in the §5 order via each package's own `runMigrations`, then applies the Supabase hardening (§19.3). Safe to re-run — every migration is journal-guarded and the hardening is idempotent. Prints only host/port/database. |
| Structural verification | `node --import tsx scripts/verifySupabaseStaging.ts structure` | No (catalog SELECTs; drift audit uses a disposable local cluster) | Physical schema, independently recomputed journals, role/grants, triggers, RLS, exposure review, drift vs reference schema. |
| Behavioural verification | `node --import tsx scripts/verifySupabaseStaging.ts behavior --grant-set-role` | Temporary: a role-membership grant, plus synthetic rows removed before exit | See §19.4. Refuses to run without the explicit flag, and refuses to write anything unless every table is already empty. |

Failure mode on partial execution is unchanged from §13 / §3: a failing migration file rolls back inside drizzle's own transaction, earlier packages stay applied, each package's journal is independent — simply re-run.

## 12. Migration Repeatability / Verification Gate

The counts below were the W1A sanity gate and remain correct (verified in §19.2). W1B automates them, and more, in `verifySupabaseStaging.ts structure`, which additionally recomputes each journal row's sha256 and timestamp from the repository's own SQL files (independent of drizzle's migrator).

```sql
-- Expect exactly 16
select count(*) from information_schema.tables where table_schema = 'public';

-- Journal row counts per package schema: 2 / 5 / 3 / 2
select count(*) from drizzle_data_foundation.__drizzle_migrations;
select count(*) from drizzle_identity_access.__drizzle_migrations;
select count(*) from drizzle_clinic_cms_connector.__drizzle_migrations;
select count(*) from drizzle_communication_orchestration.__drizzle_migrations;

-- Expect exactly 1
select count(*) from pg_roles where rolname = 'samvardiq_app';

-- Expect exactly 3 (all enabled)
select count(*) from pg_trigger where tgname in
  ('approval_requests_goal_consistency','approval_records_immutable','identity_audit_events_immutable');
```

## 13. Partial Failure / Recovery Plan

Because `samvardiq-staging` currently holds no real data, the safest recovery from any failed or partial migration attempt is: **drop and recreate the staging database (or the whole Supabase project) and re-run the full chain from empty.** This is explicitly a staging-only posture — it does not apply once staging carries data anyone depends on, and never applies to a future production project, which will need a real forward-migration/rollback discipline once real data exists.

## 14. Supabase Security Verification Plan (EXECUTED — results in §19.4)

- **Runtime role:** `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname = 'samvardiq_app'` — expect all four `false`. (All checks below that concern RLS must run as `samvardiq_app` via `SET ROLE`, never as the admin `postgres`, which has `BYPASSRLS` — §7.)
- **Tenant isolation:** as `samvardiq_app` with `app.current_org_id` set to Org A, confirm Org B's rows in every RLS-protected table are invisible; confirm INSERT/UPDATE targeting Org B's `organization_id` is rejected; confirm no `app.current_org_id` set means zero rows from any tenant-scoped table.
- **Approval audit immutability:** attempt `UPDATE`/`DELETE` on `approval_records` as `samvardiq_app` — expect the `approval_records_immutable` trigger to raise, not merely a grant-denied error.
- **Identity audit immutability:** same, for `identity_audit_events` via `identity_audit_events_immutable`.
- **CMS connector:** confirm `clinic_cms_connections`/`clinic_cms_connector_evidence` are RLS-scoped per organization; confirm no column ever holds a raw secret (only `secret_reference` strings); confirm `actor_identity_id`/`actor_principal_type` populate correctly for a synthetic write.
- **Communication:** confirm `conversations`/`communication_messages`/`communication_message_content` are RLS-scoped; confirm `communication_channels`/`webhook_event_dedup` are reachable with no organization context set (by design — see §6 of `CLINIC_W2_COMMUNICATION_ARCHITECTURE.md`) but still correctly return only their own rows via unique constraints, not cross-tenant enumeration; confirm the `webhook_event_dedup` unique constraint actually rejects a duplicate `(provider, external_event_id)`.
- **W2C handoff:** confirm `listHumanHandoffs`-shaped queries against real Supabase RLS return only the requesting organization's `HUMAN_HANDOFF_REQUESTED` conversations.

## 15. Supabase Auth Sequencing (later, not part of W1B database migration)

No Supabase Auth configuration is required before or during database migration — `identities`/`organization_memberships` are populated by Samvardiq's own application logic, not by Supabase Auth. The eventual sequence, when human staff accounts are needed: (1) create the human's account in Supabase Auth (dashboard or Admin API, outside this repository's own code), (2) create a matching `identities` row (`principalType: 'human'`) and `identity_provider_links` row (`provider: 'supabase'`, `providerSubject` = the Supabase `auth.users.id`), (3) create the `organization_memberships` row granting the intended role. No Supabase JWT claim or `auth.users` metadata is ever treated as authorization state — `AuthorizationService.resolveTrustedContext()` always re-derives authority from Samvardiq's own tables.

## 16. Backup / Recovery Capability (current tier)

Supabase does not include platform-managed backups on the Free tier; Point-in-Time Recovery is a paid add-on on every tier. For a staging project holding no real data, this is acceptable — see §13's recreate-from-empty posture. Before any production project (real patient data), this must be revisited: at minimum a paid tier with daily backups, and PITR should be evaluated against the actual compliance requirement once defined — not decided in this session.

## 17. Synthetic Staging Dataset (designed in W1A; W1B used a smaller `w1b-` dataset transiently — §19.4 — and removed it; staging currently holds no data)

| Fixture | Fields | Used for |
|---|---|---|
| Organization A — "Test Clinic Alpha" | organizationId, organizationType: clinic, name | tenant-isolation tests |
| Organization B — "Test Clinic Beta" | same shape | cross-tenant denial tests |
| Human OWNER A | identity (principalType: human), provider link (provider: supabase, a synthetic providerSubject), membership (org A, role OWNER, status ACTIVE) | membership administration / full-authority checks |
| Human MEMBER A | same shape, role MEMBER | day-to-day operation checks, W2C handoff-inbox read |
| Human VIEWER A | same shape, role VIEWER | read-only-role checks (W2C: any role reads) |
| Human OWNER B | org B equivalent of OWNER A | cross-org denial checks |
| Service identity A | identity (principalType: service), provider link (provider: whatsapp-channel), membership (org A, role MEMBER, no approverRole) | non-human authority / service-principal-denied checks (ADR-IDENTITY-002, W2C §F) |
| Communication channel A | organizationId A, a synthetic `externalChannelId` (never a real Meta phone number), synthetic `accessTokenReference` pointing at a non-existent env var | webhook/channel-resolution structural tests, never a live send |
| CMS connection metadata (org A) | a placeholder `baseUrl`, a `secretReference` pointing at a non-existent env var, `approvedScopes` | connector configuration-shape tests only — `EnvConnectorSecretProvider` already fails closed on a missing reference, so no real CMS secret is ever needed for this |

No real patient, phone number, clinic secret, Meta token, CMS credential, or medical record appears in any of the above — every value is a literal placeholder string.

## 18. Production Prohibition

This document, and the `samvardiq-staging` project it describes, are staging-only. Nothing here authorizes connecting a real WhatsApp Business number, a real Clinic CMS credential, a real AI provider, or real patient data. Production readiness is a separate, later decision requiring its own explicit Founder approval and its own infrastructure review (backup tier, PITR, region, compliance posture).

## 19. INFRA-W1B Execution Record (2026-09-21) — `samvardiq-staging` only

Nothing here touched production, configured Supabase Auth, deployed the API or web app, configured Meta/WhatsApp, connected a live Clinic CMS or an AI provider, or introduced real patient/clinical data.

### 19.1 Target and pre-migration state

- Connection: Supabase **Session Pooler**, `aws-0-ap-northeast-1.pooler.supabase.com:5432`, database `postgres`, PostgreSQL **17.6**. The tenant-suffixed pooler username is checked against the intended staging project by both the runner and the verifier; inside the session Supavisor presents it as plain `postgres`.
- Admin role `postgres`: `rolsuper = false`, `rolcreaterole = true`, **`rolbypassrls = true`**.
- Before migration: `public` held no tables and no `samvardiq_app` role existed; no `drizzle*` schemas. The only Samvardiq-relevant Supabase objects were Supabase's own `rls_auto_enable()` function and `ensure_rls` event trigger (F1, below), and default ACLs granting `anon`/`authenticated`/`service_role` full privileges on new tables, sequences and functions (F2, below). Supabase-provisioned extensions (`pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`) are the platform's; Samvardiq requires none.

### 19.2 Migrations executed and structural verification

Five invocations of `npm run migrate:staging`: **#1** migrated all four packages with the unmodified W1A-validated runner; **#2** first applied the hardening (§19.3); **#3–#5** were idempotency re-runs (no journal change, no drift). Journals after every run: `drizzle_data_foundation` 2, `drizzle_identity_access` 5, `drizzle_clinic_cms_connector` 3, `drizzle_communication_orchestration` 2 — each row's sha256 and timestamp independently recomputed from the repository's SQL files and matching.

`verifySupabaseStaging.ts structure` — **12/12**: 16 physical tables (no views/matviews); `samvardiq_app` exactly one, NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS/NOREPLICATION, no CREATE on `public`/database; the exact per-table DML grant matrix (no TRUNCATE/REFERENCES/TRIGGER anywhere); 3 governed triggers enabled with `SECURITY INVOKER` functions; 12 tenant tables `ENABLE`+`FORCE` RLS with GUC-keyed policies and 4 platform-global tables RLS-on with only the scoped policy; no credential-bearing column other than `*_reference` (`secret_reference`, `access_token_reference`); `anon`/`authenticated` hold no privilege; the runtime role can reach nothing outside `public`; **S8: `postgres` cannot `SET ROLE samvardiq_app` (this is what would expose a temporary grant left behind by a killed verification session — remedy: `REVOKE samvardiq_app FROM postgres`)**; **drift audit: 14 catalog categories / 304 items identical** to a reference cluster migrated and hardened by the same code.

### 19.3 Supabase findings F1 and F2 (the W1A "no incompatibility" claim was false)

- **F1 — automatic RLS with no policy.** Supabase's `ensure_rls` event trigger runs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on every table created in `public`. The four platform-global tables — `identities`, `identity_provider_links`, `communication_channels`, `webhook_event_dedup` — are deliberately created **without** RLS (a channel/identity/dedup lookup has no organization yet), so on Supabase they became RLS-enabled with **zero policies**: deny-all for `samvardiq_app`, i.e. a broken runtime that every local test still passed. Observed on the real project after run #1. **Fix:** RLS stays enabled (deny-by-default for every other role) and one permissive policy `samvardiq_app_platform_global ... FOR ALL TO samvardiq_app USING (true) WITH CHECK (true)` is added per table; grants, not the policy, still bound the runtime role.
- **F2 — over-broad default privileges.** `anon`, `authenticated` and `service_role` held full privileges on all 16 tables, and the 3 trigger functions were executable by PUBLIC. **Fix:** revoke everything on all `public` tables and sequences from `anon` and `authenticated`, and revoke EXECUTE on the 3 Samvardiq functions from PUBLIC and from those roles (a trigger function's EXECUTE privilege is checked at `CREATE TRIGGER`, never when the trigger fires, so runtime is unaffected). The revoke covers **every** table in `public` — Samvardiq owns `public` on this project.

The fix is `apps/api/scripts/supabaseHardening.ts`, applied by the runner after the four migrations and idempotent. Regression coverage rehearses Supabase's real `ensure_rls` trigger, default ACLs and roles on a disposable cluster: `apps/api/test/integration/supabasePlatform.test.ts` (the defects reproduce without the fix; the fix repairs them; idempotent; the platform-global list is exhaustive) and `stagingVerifier.test.ts` (the verifier passes on the correct schema and **fails** on the F1/F2-defective one).

**Deliberately not done** (explicit deferred security decisions, §19.5): `service_role` privileges are unchanged; the Data API exposed-schema configuration is unchanged; default ACLs for *future* tables are not altered.

### 19.4 Behavioural verification on staging (as the real runtime role) — 21/21

Because `postgres` has `BYPASSRLS`, RLS can only be proven as `samvardiq_app`. `postgres` is a member of it (platform-granted by `supabase_admin`, ADMIN OPTION, **no SET**), so the Founder authorized exactly one temporary change, `GRANT samvardiq_app TO postgres WITH SET TRUE` — no password, no LOGIN, no privilege change — scoped to the verification session and revoked afterwards. `verifySupabaseStaging.ts behavior --grant-set-role` implements the lifecycle (`temporaryRoleGrant.ts`): record the pre-grant state (P1) → grant → prove `SET ROLE` yields `current_user = samvardiq_app`, `rolbypassrls = false`, `rolsuper = false` (P2) → run the suite as `samvardiq_app` on every pooled session → **always** revoke on a cleanup path that runs even if the suite aborts, and independently prove restoration (R1–R3).

Results (all PASS, against `samvardiq-staging`, the four packages' real repositories, synthetic `w1b-` data only):

- **B0** every table empty beforehand (the suite refuses to write otherwise); **B1** all pooled sessions are `samvardiq_app`, NOBYPASSRLS.
- **B2** cross-organization isolation (repository and raw SQL; cross-org INSERT = `42501`, cross-org UPDATE = 0 rows). **B12** missing-context fail-closed across all 12 tenant tables and 4 pools (`identity_audit_events` exposes only its designed global events), plus no-context writes rejected `42501`.
- **B3** approval atomicity (commit = request + record; induced failure rolls back both). **B4** concurrency (two simultaneous decisions → exactly one record, one `ApprovalRequestConcurrencyError`). **B5** approval-record immutability: runtime UPDATE/DELETE `42501`, even the owner blocked by the trigger (`P0001`); goal-consistency trigger rejects a mismatch.
- **B6/B7** identity provisioning as the runtime role (the F1 fix proof) and membership authorization (OWNER/MEMBER/VIEWER/service; cross-org, unlinked, suspended denied; a service principal never carries approval authority); org-or-self membership reads, identity context read-only, spoofed insert `42501`. **B8** identity-audit isolation + immutability (`42501` / owner `P0001`).
- **B9** CMS connector: per-organization connection, reference-only secret, evidence with human and service actors, actor CHECK (`23514`), cross-org denial. **B10** communication: platform-global channel lookup, duplicate rejection (`23505`), isolated conversations/messages/raw content, dedup, purge. **B11** W2C handoff read path: RLS-scoped, `HUMAN_HANDOFF_REQUESTED` only, real `timestamptz` ordering and cursor pagination.
- **B13** every persisted row synthetic; **B14** no pooled session ever failed its role switch; **B15** cleanup.

**Synthetic-data cleanup.** Cleanup is `TRUNCATE` by the owner, not `DELETE`: the immutability triggers (correctly) forbid DELETE on `approval_records` and `identity_audit_events` even for the owner. It is safe only because the suite refuses to start unless all 16 tables are empty, and **re-proves "only `w1b-` rows exist" immediately before truncating** — otherwise it refuses and destroys nothing. After the run all 16 tables were empty, the 3 triggers still enabled, journals unchanged.

**Temporary role membership — proven revoked (R1–R3, plus a separate independent query).** After the run, the only membership edge on `samvardiq_app` is the original platform one (member `postgres`, grantor `supabase_admin`, ADMIN OPTION, INHERIT false, SET false), identical to the P1 record; `pg_has_role('postgres','samvardiq_app','SET')` is `false`; `samvardiq_app` attributes are identical to before (it did **not** gain LOGIN — it has had `LOGIN` since its migration `CREATE ROLE`, passwordless by design — nor SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION); the runtime grant matrix is unchanged. `REVOKE samvardiq_app FROM postgres` removes only grants **made by `postgres`** — the temporary edge; the `supabase_admin`-granted edge is platform provisioning that this workstream neither created nor may remove, and removing it would stop `postgres` from administering the role (e.g. provisioning its password later). The lifecycle is regression-tested (`temporaryRoleGrant.test.ts`): staging-shaped topology, in-place edge, no prior edge, an aborted suite, and a failed pre-check that must issue no grant at all.

### 19.5 Deferred security decisions and open items (each needs its own Founder decision)

1. **`service_role`** still holds its default privileges on all 16 tables. It is a server-only key that bypasses RLS by platform design and is never used or issued by any Samvardiq component (§10) — but it is a standing risk if that key ever leaks; whether to revoke it is deferred.
2. **Data API exposed-schema setting** is a project setting not readable via SQL and was not changed. Verify in the Supabase dashboard that `public` is not exposed; even if it were, `anon`/`authenticated` hold no privilege and RLS is enabled on every table.
3. **Default ACLs for future objects** are unchanged; re-run `npm run migrate:staging` after any new migration to re-apply the revokes and the platform-global policy list (`supabaseHardening.ts`), and update `PLATFORM_GLOBAL_TABLES` when a new RLS-free table is designed — the verifier fails on any unclassified table.
4. **Runtime credential:** `samvardiq_app` has no password. Provisioning it and choosing the runtime connection (Direct vs Session Pooler, §8) belongs to the later API-deployment workstream.
5. Four moderate, **dev-only** advisories (`drizzle-kit` → `esbuild` dev-server, GHSA-67mh-4wv8-2f99) exist in four packages, pre-date this work, and their only offered fix is a semver-major downgrade; deferred.
6. The staging pooler username is a constant in `stagingDb.ts` (an identifier, not a secret); a second staging project would need it made configurable.

### 19.6 Reproduce

From `apps/api/`, with `SAMVARDIQ_DEPLOY_ENV=staging` and `MIGRATION_DATABASE_URL` in your own shell: `npm run migrate:staging` (idempotent) → `node --import tsx scripts/verifySupabaseStaging.ts structure` (read-only) → `node --import tsx scripts/verifySupabaseStaging.ts behavior --grant-set-role` (only with explicit authorization of the temporary role grant).

## 20. INFRA-W1C Execution Record (2026-09-22) — Supabase Data API & Privilege Surface Hardening

Scope: `samvardiq-staging` only. No Supabase Auth, API/web deployment, Meta/WhatsApp configuration, live Clinic CMS connection, AI provider configuration, or production change was made.

### 20.1 Authority review

`ADR-FRONTEND-001` (`ARCH-018`) already settles the general policy question this workstream opened with. Its binding Frontend-Boundary Rules state: `apps/web` "never talks to PostgreSQL or Supabase's database directly" (rule 1) and may use `@supabase/supabase-js` "for ONE purpose only: obtaining/refreshing a session... It never queries Supabase's database or storage" (rule 2, restating `ARCH-016`). No new ADR was needed to conclude that Samvardiq's transactional tables are not meant to be reachable through the Data API by any first-party client — that was already decided. `docs/11_Decisions.md` confirms `ARCH-019` remains the highest recorded identifier; none was consumed.

### 20.2 Repository Data API usage audit (Step 7) — none exists

`apps/web/src/auth/supabaseClient.ts` is the only `@supabase/supabase-js` import anywhere in the repository, and it calls only `.auth.signInWithPassword`, `.auth.signOut`, `.auth.getSession`, `.auth.onAuthStateChange` — never `.from()` or `.rpc()`. No `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY` is read server-side anywhere. No Edge Function, no raw `/rest/v1` call, no RPC invocation exists in application code.

### 20.3 Actual staging privilege/exposure inventory (Steps 3–4)

A read-only catalog inventory (schemas, tables, sequences, functions, policies, triggers, default ACLs, role grants/attributes/memberships) found **zero unclassified Samvardiq objects**: 9 runtime-transactional tables, 4 platform-global runtime tables, 3 audit tables, 3 trigger functions, 4 migration-journal schemas, 0 sequences (all primary keys are application-generated strings, per `ADR-DATA-001`). `anon`/`authenticated` hold zero grants on any of the 16 tables (confirmed both in the catalog and by a live HTTP probe, §20.4). `service_role` holds full grants on all 16 (unchanged, `bypassrls=true`, never used by Samvardiq — §20.6). `postgres`'s own pre-existing membership in `samvardiq_app` (granted by `supabase_admin`, ADMIN OPTION, no SET) is unchanged from W1B.

### 20.4 Data API configuration — established without a dashboard screenshot

Rather than ask the Founder for a dashboard screenshot, this was established two ways:

1. **Supabase's own security advisor** (read-only, via the authenticated Supabase management connector — no database credential involved) flagged `public.rls_auto_enable()`, a `SECURITY DEFINER` function, as callable by `anon`/`authenticated` via `/rest/v1/rpc/rls_auto_enable`. An RPC route existing at all is only possible if `public` is a Data-API-exposed schema.
2. **A live black-box HTTP probe**, using only the publishable (non-secret-by-design) anon key, against the real project (`https://kobkelmeoufdaaesupgf.supabase.co`), confirmed this directly (§20.8): `GET /rest/v1/goals`, `/organizations`, `/identities`, `/approval_records` and `POST /rest/v1/organizations` all returned `401` with Postgres SQLSTATE `42501` ("permission denied for table X") — a permission failure from Postgres itself, not a `404` from PostgREST's schema cache, which is what a non-exposed schema would return.

**Conclusion: `public` is currently Data-API-exposed.** No mutation was made to this setting (out of this session's scope by explicit instruction) — see §20.6.

### 20.5 Threat model (Step 6) — summary

| # | Question | Classification |
|---|---|---|
| 1–2 | Can `anon`/`authenticated` reach any Samvardiq table? | **PREVENTED** — zero grants (catalog + live HTTP proof, `42501` on every path tried) |
| 3 | Can `service_role` reach Samvardiq tables? | **ACCEPTED BY AUTHORITY (deferred)** — yes, by design, unused by Samvardiq; narrowing is a Founder decision (§20.6) |
| 4 | Does `service_role` bypass RLS? | **NOT APPLICABLE to Samvardiq** — platform contract, never issued to any Samvardiq component |
| 5 | Can exposed schemas make tables *discoverable*? | **CURRENTLY EXPOSED** (informational) — `public` is Data-API-exposed, but zero grants mean no read/write capability regardless (§20.4) |
| 6 | Trigger/support functions executable by an unintended role? | **PREVENTED** — `PUBLIC`/`anon`/`authenticated` revoked on all 3 (F2); default-ACL closed for future functions except the documented PUBLIC residual (F3, §20.7) |
| 7 | Sequences exposed? | **NOT APPLICABLE** — zero sequences exist |
| 8 | Can audit tables be modified? | **PREVENTED** — immutability triggers (W1B), unchanged |
| 9 | Can platform-global tables be modified by an unintended role? | **PREVENTED** — scoped policy, `anon`/`authenticated` zero grants |
| 10 | Identity tables reachable outside the governed API? | **PREVENTED** — same zero-grant proof |
| 11 | Connector secrets reachable? | **NOT APPLICABLE** — only `*_reference` columns exist; no secret value is ever stored |
| 12 | Communication records reachable? | **PREVENTED** — same zero-grant proof |
| 13 | Future tables inherit unsafe privileges? | **REQUIRES HARDENING → FIXED** (F3, §20.7) for `anon`/`authenticated`; `service_role` deliberately unchanged |
| 14–18 | Migration/`samvardiq_app`/future-Auth/identity-adapter/RLS breakage risk? | **PREVENTED** — structural drift audit (§20.9) proves the runtime grant matrix, RLS, FORCE RLS and triggers are byte-identical before/after |
| 19 | Hidden Supabase SDK dependency introduced? | **NOT APPLICABLE** — no new dependency; the Supabase management connector used for read-only discovery is operator tooling, not application code |
| 20 | Is any Data API access actually required by current source? | **NOT APPLICABLE** — confirmed none (§20.2) |

### 20.6 `service_role` decision — RETAINED (deferred, not this session's call)

No Samvardiq runtime dependency on `service_role` exists: not used for migrations (those authenticate as `postgres`), not needed by the current identity/CMS/communication/W2C code (all confirmed via source audit, §20.2), not required by any approved architecture. Its privileges are **retained exactly as Supabase provisioned them** — no revoke, no narrowing — because doing so is a security-policy mutation with no existing ADR authorizing it, and this session's explicit instruction is not to change `service_role` without a separate Founder decision. If a future decision narrows it, the safest first step (once decided) is revoking `service_role`'s table/sequence grants the same way F2 did for `anon`/`authenticated`, while leaving its `BYPASSRLS`/schema-membership attributes alone (those are platform contract, not something Samvardiq's own migrations can safely alter).

### 20.7 Default-ACL and function hardening — F3, F4 (implemented; narrow extension of the already-approved F2 remediation)

- **F3 — future-object default ACLs.** F2 (W1B) only fixed *existing* objects; Supabase's own default-ACL rows for `postgres`'s future tables/sequences/functions still explicitly named `anon`/`authenticated`, so the very exposure F2 closed would silently reopen on the next migration that adds a table. Fixed via `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ... FROM anon, authenticated` for tables, sequences and functions. **Verified empirically** (a rolled-back probe `CREATE TABLE`/`CREATE SEQUENCE`/`CREATE FUNCTION` against real staging, before and after the fix) that a brand-new object no longer names `anon`/`authenticated`.
  **Honest residual gap:** PostgreSQL unconditionally grants `PUBLIC` EXECUTE to a *brand-new* function regardless of default-privilege settings — verified on both `samvardiq-staging` and a bare vanilla-Postgres cluster; `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` does not suppress it once a schema's default-ACL row has no prior explicit PUBLIC record. `service_role`'s default ACL is deliberately left untouched, same reasoning as F2/§20.6. A future migration that adds a new trigger function remains briefly `PUBLIC`-executable until it is added to `OWN_FUNCTIONS` and the hardening step is re-run — exactly the same operational discipline F2 already required and §19.5/item 3 already documented.
- **F4 — function `search_path` pinning.** Supabase's own security advisor (`function_search_path_mutable`) flagged the 3 Samvardiq trigger functions. None is `SECURITY DEFINER` (verified, all invoker-rights), so this could never enable privilege escalation, but pinning `search_path = public, pg_temp` is cheap, idempotent, and closes the advisory with zero behaviour change — verified locally that the goal-consistency trigger still resolves its one bare table reference and still correctly rejects a mismatched request after the pin. **Re-running Supabase's advisor after applying this to staging confirmed the `function_search_path_mutable` finding is gone.** The two remaining advisor findings (`anon`/`authenticated_security_definer_function_executable`, both about `public.rls_auto_enable()`) concern a Supabase-owned function this workstream deliberately does not modify (§20.6's "don't touch Supabase-managed objects" reasoning) — direct invocation was proven harmless (§20.8).

Both are applied by the existing `apps/api/scripts/supabaseHardening.ts` (same idempotent entry point as F1/F2 — no new script, no new abstraction) and regression-tested in `apps/api/test/integration/supabasePlatform.test.ts`.

### 20.8 Data API negative tests (Step 18) — real HTTP, not just SQL inference

Using the publishable anon key against `https://kobkelmeoufdaaesupgf.supabase.co`:

| Request | Result |
|---|---|
| `GET /rest/v1/goals?select=*` | `401`, SQLSTATE `42501` permission denied |
| `GET /rest/v1/organizations?select=*` | `401`, `42501` |
| `GET /rest/v1/identities?select=*` (platform-global table) | `401`, `42501` |
| `GET /rest/v1/approval_records?select=*` (audit table) | `401`, `42501` |
| `POST /rest/v1/organizations` (insert attempt) | `401`, `42501` |
| `POST /rest/v1/rpc/rls_auto_enable` | `400`, harmless (`cannot display a value of type event_trigger` — the function requires real event-trigger context) |
| `GET /rest/v1/` (schema introspection) | `401`, "Only the `service_role` API key can be used for this endpoint" |

`authenticated`'s equivalent behaviour was not tested with a live HTTP request (fabricating a Supabase Auth session is out of this session's scope), but is dispositive from the catalog alone: `authenticated` holds the same zero grants as `anon` (§20.3), and Postgres's grant check happens before RLS evaluation, so the same `42501` outcome is structurally guaranteed regardless of a valid JWT. `service_role`'s Data API behaviour was not tested — its key is not publishable and was correctly never read or handled.

### 20.9 Post-mutation structural verification, idempotency, drift

`verifySupabaseStaging.ts structure` — **14/14** (12 from W1B/S1–S8, plus new **S9** default-ACL and **S10** search_path checks). Drift audit: **15 categories / 307 catalog items identical** to a reference cluster built by the identical migration+hardening code (up from 14/304 in W1B — the new categories are the default-ACL fingerprint and the two additional `functions`/`S9`/`S10`-covered facts folded into existing categories). The hardening runner was executed twice more (idempotent both times): journals unchanged (2/5/3/2), no privilege re-expansion, `S4`'s runtime grant matrix for `samvardiq_app` byte-identical throughout.

### 20.10 Runtime-role regression assessment — no new temporary grant needed

F3/F4 touch only (a) default privileges governing *future* objects Samvardiq's own migrations haven't created yet, and (b) `search_path` on 3 existing `SECURITY INVOKER` functions. Neither can change `samvardiq_app`'s own grants, RLS policies, FORCE RLS, or trigger enablement — all proven byte-identical before/after by the drift audit (§20.9), and the search_path pin's zero-behaviour-change claim was independently proven locally (§20.7). No plausible regression path to `samvardiq_app`'s runtime behaviour exists, so — per this session's own instruction — the W1B temporary `GRANT samvardiq_app TO postgres WITH SET TRUE` lifecycle was **not** re-invoked. The 21/21 behavioural proof from W1B (unaffected by anything in this workstream) stands as the current behavioural evidence.

### 20.11 Deferred (unchanged from, or newly added to, §19.5)

1. **`service_role`** — retained; see §20.6.
2. **Data API exposed-schema list** — now known to include `public` (§20.4); narrowing it (removing `public` from the Data API's exposed schemas, since no first-party client needs it there) is a genuine Founder/operator dashboard decision, not made in this session.
3. **Default ACLs for `service_role`** — deliberately unchanged, same reasoning as item 1.
4. **The `PUBLIC`-execute residual on brand-new functions** (§20.7) — not closeable at the default-privilege level on this platform; remains dependent on the existing "add to `OWN_FUNCTIONS`, re-run the hardening step" discipline.
5. **`samvardiq_app` runtime credential** — still unset; belongs to INFRA-W1D (the future deployed API's database-credential strategy), not this workstream.
6. Items 4–6 from §19.5 (dev-only dependency advisories, the pooler-username constant) are unchanged.
