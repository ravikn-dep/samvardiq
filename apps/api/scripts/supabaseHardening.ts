/**
 * INFRA-W1B/W1C — Supabase-platform adaptation, applied after the four
 * package migrations and re-applied (idempotently) on every run of the
 * staging runner. Repository schema is unchanged; this only reconciles
 * behaviours of the Supabase platform that the local (vanilla PostgreSQL)
 * proofs cannot show:
 *
 * F1 (W1B). Supabase's `ensure_rls` event trigger runs `ENABLE ROW LEVEL
 *     SECURITY` on every table created in `public`. The four platform-global
 *     tables below are deliberately created *without* RLS (a channel/
 *     identity/dedup lookup has no organization yet), so on Supabase they
 *     became RLS-enabled with zero policies — deny-all for `samvardiq_app`,
 *     i.e. a broken runtime. We keep RLS on (deny-by-default for every other
 *     role) and add one permissive policy scoped `TO samvardiq_app` only.
 * F2 (W1B). Supabase's default ACLs grant `anon`/`authenticated` (the roles
 *     behind the browser-safe publishable key and the Data API) full rights
 *     on every EXISTING `public` table/sequence/function at migration time.
 *     Samvardiq's backend never uses them — verified in INFRA-W1C: no
 *     `.from()`/`.rpc()` call exists anywhere in the repository (see
 *     ADR-FRONTEND-001 Frontend-Boundary Rules 1–2), and a live black-box
 *     probe against the real Data API with the publishable anon key returned
 *     `42501 permission denied` on every table — so they are revoked here.
 *     `service_role` (server-only, bypasses RLS by design, never issued to
 *     any Samvardiq component) is deliberately left untouched — it is a
 *     platform contract, not a client exposure, and any change to it is a
 *     separate Founder decision (tracked, not made, in INFRA-W1C).
 * F3 (W1C). F2 only fixed *existing* objects. Supabase's own default-ACL
 *     entries (`pg_default_acl`, owned by whichever role runs migrations)
 *     still explicitly named `anon`/`authenticated` for every FUTURE table,
 *     sequence and function — the very defect F2 fixed would silently
 *     reopen on the next migration that adds a table, if this step were
 *     ever skipped. Pinned here at the default-privilege level for tables
 *     and sequences; **verified empirically (a rolled-back probe CREATE
 *     against samvardiq-staging) to genuinely prevent `anon`/`authenticated`
 *     from appearing on a brand-new object.** `service_role`'s default ACL
 *     is deliberately left untouched, same reasoning as F2.
 *
 *     Known residual gap, honestly documented rather than papered over:
 *     PostgreSQL unconditionally grants `PUBLIC` EXECUTE to a *brand-new*
 *     function regardless of default-privilege settings once a schema's
 *     default-ACL row for functions has no prior explicit PUBLIC record —
 *     verified on both this project and a bare vanilla-Postgres cluster.
 *     `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
 *     is still applied below (matches Supabase's own recommended hardening
 *     pattern and is harmless), but a *new* trigger function this hardening
 *     step has never seen remains briefly PUBLIC-executable until it is
 *     added to `OWN_FUNCTIONS` below and this step is re-run — exactly the
 *     same "re-run after any new migration" discipline F2 already required.
 * F4 (W1C). Supabase's own security advisor (`function_search_path_mutable`)
 *     flags the three Samvardiq trigger functions for not pinning
 *     `search_path`. None is `SECURITY DEFINER` (verified — all three are
 *     invoker-rights), so this cannot enable a privilege-escalation path
 *     either way, but pinning is cheap, idempotent, and closes the advisory
 *     with zero behaviour change: `enforce_approval_request_goal_consistency`
 *     already resolves its one bare table reference (`recommendations`)
 *     against `public`, which `search_path = public, pg_temp` keeps true
 *     unconditionally rather than relying on the session default.
 *
 * The F2/F3 revokes cover EVERY table/sequence in `public` (Samvardiq owns
 * `public` on this project; anything a future workstream wants exposed
 * through the Data API must live in another schema or be re-granted
 * deliberately).
 */

/** Tables intentionally designed without tenant RLS (see each package's schema docs). */
export const PLATFORM_GLOBAL_TABLES = ['identities', 'identity_provider_links', 'communication_channels', 'webhook_event_dedup'] as const;

/** Trigger functions created by the package migrations. */
export const OWN_FUNCTIONS = ['enforce_approval_request_goal_consistency', 'prevent_approval_record_mutation', 'prevent_identity_audit_event_mutation'] as const;

/** Roles reachable from a browser/Data API client — must hold no privilege on Samvardiq objects, now or on any future object. */
export const CLIENT_FACING_ROLES = ['anon', 'authenticated'] as const;

export const PLATFORM_GLOBAL_POLICY = 'samvardiq_app_platform_global';

/** search_path pinned on every Samvardiq function (F4) — matches the schema every bare reference inside them already resolves against. */
export const PINNED_SEARCH_PATH = 'public, pg_temp';

const literalList = (values: readonly string[]) => `ARRAY[${values.map((v) => `'${v}'`).join(', ')}]`;

export const SUPABASE_HARDENING_SQL = `
DO $$
DECLARE
  t text;
  f text;
  r text;
BEGIN
  FOREACH t IN ARRAY ${literalList(PLATFORM_GLOBAL_TABLES)} LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS ${PLATFORM_GLOBAL_POLICY} ON public.%I', t);
    EXECUTE format('CREATE POLICY ${PLATFORM_GLOBAL_POLICY} ON public.%I FOR ALL TO samvardiq_app USING (true) WITH CHECK (true)', t);
  END LOOP;

  -- F2: a new function is EXECUTE-able by PUBLIC (hence by anon/authenticated) unless revoked from PUBLIC itself.
  -- Safe: a trigger function's EXECUTE privilege is checked at CREATE TRIGGER, never when the trigger fires.
  FOREACH f IN ARRAY ${literalList(OWN_FUNCTIONS)} LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC', f);
    -- F4: pin search_path (see file header). ALTER FUNCTION is idempotent and changes no behavior here.
    EXECUTE format('ALTER FUNCTION public.%I() SET search_path = ${PINNED_SEARCH_PATH}', f);
  END LOOP;

  FOREACH r IN ARRAY ${literalList(CLIENT_FACING_ROLES)} LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      FOREACH f IN ARRAY ${literalList(OWN_FUNCTIONS)} LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM %I', f, r);
      END LOOP;
      -- F3: fix the default ACL too, so a future migration's new object never reopens F2. Verified
      -- empirically against samvardiq-staging (a rolled-back probe CREATE) that a brand-new object's
      -- default ACL grants each of anon/authenticated its OWN named entry for tables/sequences/
      -- functions alike — revoking only from PUBLIC below is not sufficient on its own.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;

  -- F3 (functions, PUBLIC): a brand-new function's default ACL also carries an explicit PUBLIC entry
  -- (confirmed by the same probe) on top of the named-role entries revoked above.
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
END
$$;
`;

export async function applySupabaseHardening(pool: { query(text: string): Promise<unknown> }): Promise<void> {
  await pool.query(SUPABASE_HARDENING_SQL);
}
