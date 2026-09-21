/**
 * INFRA-W1B — Supabase-platform adaptation, applied after the four package
 * migrations and re-applied (idempotently) on every run of the staging runner.
 * Repository schema is unchanged; this only reconciles two behaviours of the
 * Supabase platform that the local (vanilla PostgreSQL) proofs cannot show:
 *
 * F1. Supabase's `ensure_rls` event trigger runs `ENABLE ROW LEVEL SECURITY`
 *     on every table created in `public`. The four platform-global tables
 *     below are deliberately created *without* RLS (a channel/identity/dedup
 *     lookup has no organization yet), so on Supabase they became RLS-enabled
 *     with zero policies — deny-all for `samvardiq_app`, i.e. a broken
 *     runtime. We keep RLS on (deny-by-default for every other role) and add
 *     one permissive policy scoped `TO samvardiq_app` only.
 * F2. Supabase's default ACLs grant `anon`/`authenticated` (the roles behind
 *     the browser-safe publishable key and the Data API) full rights on every
 *     new `public` table/sequence/function. Samvardiq's backend never uses
 *     them, so they are revoked. `service_role` (server-only, bypasses RLS by
 *     design, never issued to any Samvardiq component) is deliberately left
 *     untouched — it is a platform contract, not a client exposure.
 *
 * The revokes cover EVERY table/sequence in `public` (Samvardiq owns `public`
 * on this project; anything a future workstream wants exposed through the Data
 * API must live in another schema or be re-granted deliberately).
 *
 * Existing objects only: default ACLs for *future* tables are not altered
 * (that would change platform-wide behaviour); re-running the runner after
 * any new migration re-applies the revokes.
 */

/** Tables intentionally designed without tenant RLS (see each package's schema docs). */
export const PLATFORM_GLOBAL_TABLES = ['identities', 'identity_provider_links', 'communication_channels', 'webhook_event_dedup'] as const;

/** Trigger functions created by the package migrations. */
export const OWN_FUNCTIONS = ['enforce_approval_request_goal_consistency', 'prevent_approval_record_mutation', 'prevent_identity_audit_event_mutation'] as const;

/** Roles reachable from a browser/Data API client — must hold no privilege on Samvardiq objects. */
export const CLIENT_FACING_ROLES = ['anon', 'authenticated'] as const;

export const PLATFORM_GLOBAL_POLICY = 'samvardiq_app_platform_global';

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

  -- A new function is EXECUTE-able by PUBLIC (hence by anon/authenticated) unless revoked from PUBLIC itself.
  -- Safe: a trigger function's EXECUTE privilege is checked at CREATE TRIGGER, never when the trigger fires.
  FOREACH f IN ARRAY ${literalList(OWN_FUNCTIONS)} LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC', f);
  END LOOP;

  FOREACH r IN ARRAY ${literalList(CLIENT_FACING_ROLES)} LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      FOREACH f IN ARRAY ${literalList(OWN_FUNCTIONS)} LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM %I', f, r);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
`;

export async function applySupabaseHardening(pool: { query(text: string): Promise<unknown> }): Promise<void> {
  await pool.query(SUPABASE_HARDENING_SQL);
}
