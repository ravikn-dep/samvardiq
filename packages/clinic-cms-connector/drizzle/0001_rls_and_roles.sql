-- CLINIC-W1B-2: application runtime role, Row Level Security. Not
-- expressible in Drizzle's schema DSL, hence hand-written — same
-- convention as data-foundation/drizzle/0001_rls_and_roles.sql and
-- identity-access/drizzle/0001_rls_membership_and_role.sql.
--
-- Reuses the same `samvardiq_app` role name every other package already
-- established. No password is set here and none is committed anywhere in
-- this repository — see those packages' own migrations for the identical
-- note on how a real deployment/test harness provisions it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samvardiq_app') THEN
    CREATE ROLE samvardiq_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO samvardiq_app;

-- clinic_cms_connections: SELECT/INSERT/UPDATE only — no DELETE. A
-- connection is disabled via `enabled = false`, never removed; least
-- privilege on a table that carries a secret REFERENCE (never the secret
-- itself, but still sensitive configuration).
GRANT SELECT, INSERT, UPDATE ON clinic_cms_connections TO samvardiq_app;

-- clinic_cms_connector_evidence: SELECT/INSERT only — append-only evidence,
-- same one-layer immutability posture ADR-DATA-001 recommended as the "now"
-- layer for approval_records before its stronger trigger was added. A
-- trigger-based, role-independent immutability layer (like
-- approval_records_immutable) can be added later if this evidence table
-- needs approval-record-grade guarantees; not justified for connector
-- telemetry at this stage.
GRANT SELECT, INSERT ON clinic_cms_connector_evidence TO samvardiq_app;

-- --------------------------------------------------------------------------
-- Row Level Security (organization isolation, defense-in-depth alongside
-- this package's organization-scoped repository method signatures).
--
-- Trusted context: `app.current_org_id`, set via
-- set_config('app.current_org_id', $1, true) at the start of every
-- transaction using an organizationId already resolved from a verified
-- TrustedOrganizationContext (never a raw client-supplied value) — the
-- exact same pattern every other package's RLS policy already relies on.
--
-- FORCE ROW LEVEL SECURITY is enabled for portability, matching every
-- other package's own migration.
-- --------------------------------------------------------------------------

ALTER TABLE clinic_cms_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_cms_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_cms_connections_tenant_isolation ON clinic_cms_connections
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE clinic_cms_connector_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_cms_connector_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY clinic_cms_connector_evidence_tenant_isolation ON clinic_cms_connector_evidence
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));
