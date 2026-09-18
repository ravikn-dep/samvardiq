# Supabase Staging Migration Runbook

**STATUS: PREFLIGHT / NOT YET EXECUTED.** Produced by INFRA-W1A (discovery/audit only). No Supabase project has been modified. No secret value appears anywhere in this document.

**Depends on:** `ADR-DATA-001` (Supabase-managed PostgreSQL approved as hosting, `ARCH` decisions register), `ADR-IDENTITY-001`/`ADR-IDENTITY-002`. Samvardiq checkpoint at time of writing: `3a7d7836e17c2830cb8b0277a1b238e85add0d4b`.

---

## 1. Purpose

Define the exact, safe procedure for applying Samvardiq's four canonical PostgreSQL migration chains to the empty `samvardiq-staging` Supabase project, and the verification gates that must pass before staging is considered usable. This document is the W1B execution guide; W1A performed no remote action.

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

ADR-DATA-001 already approves Supabase-managed PostgreSQL, already names "some superuser-level Postgres operations are restricted on managed platforms" as an accepted, anticipated weakness, and already commits to vanilla-Postgres portability. Every migration in this repository uses only standard DDL/DCL Supabase's documented `postgres` role supports (`CREATE ROLE`, `GRANT`/`REVOKE`, `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `CREATE FUNCTION`/`CREATE TRIGGER`, standard indexes/constraints). Zero PostgreSQL extensions are required anywhere in this codebase. No new ADR is required for this deployment; the migration-journal-sharing defect above is a repository code-quality/safety issue, not an architectural conflict with Supabase.

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

- **PostgreSQL version:** no migration uses a version-specific feature; RLS, triggers, jsonb, and `pg_roles` are all available since Postgres 9.5+. Supabase's current default (17/18 generation) is far in excess of any requirement here.
- **Role creation:** Supabase's provisioned `postgres` connection role is not a true cluster superuser but is documented by Supabase to carry additional privileges specifically so it can run operations normally superuser-only, including `CREATE ROLE`. All four `CREATE ROLE samvardiq_app ... NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION` statements request no privilege Supabase's `postgres` role cannot grant.
- **Grants/revokes:** every `GRANT`/table-level privilege statement in this repository is standard DCL on ordinary tables the migration-running role itself owns (having just created them) — no cross-schema or Supabase-managed-object grant is attempted.
- **RLS / FORCE RLS:** standard `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` and `CREATE POLICY` — Supabase's own dashboard treats RLS as first-class; no incompatibility.
- **Functions/triggers:** all 3 functions are plain `LANGUAGE plpgsql`, `SECURITY INVOKER` (the default — none declares `SECURITY DEFINER`), created in `public`. No incompatibility.
- **Extensions:** none required anywhere in this codebase (UUIDs are generated in application code via `crypto.randomUUID()`, never `gen_random_uuid()`/`uuid-ossp`). Nothing to enable.
- **Schema assumptions:** every table lives in `public` via plain `pgTable()` — no `pgSchema()` custom schema anywhere. `public` is exactly where Supabase expects user application tables; no conflict with Supabase's own `auth`/`storage`/`realtime` schemas, which this codebase never touches.
- **Supabase Auth coupling:** none required now, and none should be added. Samvardiq verifies Supabase-issued JWTs against the project's public JWKS endpoint (`SUPABASE_PROJECT_URL`, not a secret) and maintains its own `identities`/`organization_memberships` tables entirely independently of `auth.users`. No foreign key, trigger, or view ever references the `auth` schema. This is deliberate — ADR-IDENTITY-001's identity model doesn't couple to a specific provider's internal schema.

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

**Gap found (§3 of the W1A brief):** there is currently no separate variable for an **admin/migration** connection — `DATABASE_URL`'s own `.env.example` value already shows a `samvardiq_app`-scoped example, confirming it was never intended to carry admin credentials. **Recommended new variable (documentation only; not implemented in any file by W1A): `MIGRATION_DATABASE_URL`** — the admin/owner connection string, read only by the migration-runner script W1B will write, kept separate from `DATABASE_URL` at every point. No existing file needs to change to introduce this name; the not-yet-written migration script will read it directly.

## 10. Secret Handling

- `.gitignore` already excludes `.env` and `.env.*`, with an explicit `!.env.example` exception — confirmed correct, unchanged.
- No `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, or `SUPABASE_JWT_SECRET` is read anywhere in this codebase — Samvardiq's backend never needs a service-role key; `apps/web` uses only the publishable (anon) key, which Supabase itself documents as safe to ship in a browser bundle.
- For W1B, the Founder provides `MIGRATION_DATABASE_URL` and (if rotated) `DATABASE_URL`/`SUPABASE_PROJECT_URL` **locally**, via their own shell environment or a local, gitignored `.env` file copied from the relevant `.env.example` — never pasted into a chat/prompt with an AI assistant, consistent with this session's own operating constraint.

## 11. Migration Execution Commands — Do NOT Execute Yet

**No repository-native command to run migrations against a real remote database currently exists.** `runMigrations()` is today only ever called from test harnesses (`packages/*/test/integration/harness.ts`, `packages/*/test/integration/migration.test.ts`), each constructing its own `createPostgresClient({ connectionString })` with an explicit, test-local connection string — never from `process.env.MIGRATION_DATABASE_URL`. No package's `package.json` defines a `migrate`/`db:migrate` script, and `apps/api`'s composition root (`src/index.ts`) never calls `runMigrations` (migrations are correctly kept out of application boot).

**W1B's first deliverable is therefore writing a small migration-runner script** (not a repository defect — simply not yet built, since no remote database has existed to run it against until now). It should:
1. Read `MIGRATION_DATABASE_URL` from the environment (never hardcoded, never logged).
2. Call each package's own `createPostgresClient({ connectionString: process.env.MIGRATION_DATABASE_URL })` + `runMigrations(client.db, <package>/drizzle)`, in exactly the order in §5.
3. After all four, run the verification queries in §12 before reporting success.

Every command below assumes that script exists as `scripts/migrateSupabaseStaging.ts` (illustrative name; W1B may choose otherwise) run via `npx tsx` from the repository root, with `MIGRATION_DATABASE_URL` set in the invoking shell.

| Step | Working directory | Required env | Mutates DB | Expected objects | Safe to rerun | Failure mode on partial execution |
|---|---|---|---|---|---|---|
| Run the script once | repo root | `MIGRATION_DATABASE_URL` | Yes | All 16 tables, `samvardiq_app` role, all RLS/policies/triggers listed in §5 | Yes — every migration is itself idempotent (`IF NOT EXISTS` role guard; each package's own migrator, now independently scoped per §3, skips its own already-applied migrations) | If it fails partway through one package's own migration file, that migration runs inside drizzle's own transaction and rolls back cleanly for that file; other packages' already-completed migrations are unaffected regardless of run order, since §3's fix made each package's journal independent. Simply re-run the script. |

## 12. Migration Repeatability / Verification Gate

Run these read-only checks against `MIGRATION_DATABASE_URL` (or `DATABASE_URL`) after the migration run, as a straightforward sanity check (no longer a defense against the §3 failure mode, which is now structurally impossible, but still good practice for any deployment step):

```sql
-- Expect exactly 16
select count(*) from information_schema.tables where table_schema = 'public';

-- Expect exactly 2 in each package's own schema, e.g.:
select count(*) from drizzle_data_foundation.__drizzle_migrations;      -- 2
select count(*) from drizzle_identity_access.__drizzle_migrations;      -- 5
select count(*) from drizzle_clinic_cms_connector.__drizzle_migrations; -- 3
select count(*) from drizzle_communication_orchestration.__drizzle_migrations; -- 2

-- Expect exactly 1
select count(*) from pg_roles where rolname = 'samvardiq_app';

-- Expect exactly 3
select count(*) from pg_trigger where tgname in
  ('approval_requests_goal_consistency','approval_records_immutable','identity_audit_events_immutable');
```

If any count is wrong, something in that specific package's migration chain genuinely failed (not a cross-package ordering artifact) — investigate that package's own migration output directly.

## 13. Partial Failure / Recovery Plan

Because `samvardiq-staging` currently holds no real data, the safest recovery from any failed or partial migration attempt is: **drop and recreate the staging database (or the whole Supabase project) and re-run the full chain from empty.** This is explicitly a staging-only posture — it does not apply once staging carries data anyone depends on, and never applies to a future production project, which will need a real forward-migration/rollback discipline once real data exists.

## 14. Supabase Security Verification Plan (for W1B, against the real project)

- **Runtime role:** `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname = 'samvardiq_app'` — expect all four `false`.
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

## 17. Synthetic Staging Dataset (designed here, not inserted)

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
