/**
 * INFRA-W1B — LOCAL REHEARSAL ONLY. Recreates, in a disposable vanilla-Postgres
 * cluster, the Supabase-platform behaviours that shaped the staging hardening
 * (see supabaseHardening.ts): the client-facing roles, Supabase's default
 * ACLs, and Supabase's `ensure_rls` event trigger (function body taken
 * verbatim from the real staging project, minus its logging). Needs a
 * superuser (event triggers). Never run against a real project.
 */
export const SUPABASE_PLATFORM_SIMULATION = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Matches real Supabase's own bootstrap exactly (verified against samvardiq-staging's pg_default_acl,
-- INFRA-W1C): the admin role itself is explicitly named alongside anon/authenticated/service_role,
-- redundant with ownership but present in the real row, so the W1C drift audit compares like for like.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $fn$
DECLARE cmd record;
BEGIN
  FOR cmd IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') AND object_type IN ('table','partitioned table')
  LOOP
    IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') THEN
      EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
    END IF;
  END LOOP;
END;
$fn$;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') EXECUTE FUNCTION public.rls_auto_enable();
`;
