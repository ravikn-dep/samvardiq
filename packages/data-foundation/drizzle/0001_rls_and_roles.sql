-- DATA-W3: application runtime role, Row Level Security, and approval-record
-- immutability. Not expressible in Drizzle's schema DSL, hence hand-written.
--
-- No password is set for samvardiq_app here and none is committed anywhere
-- in this repository. A real deployment provisions that credential through
-- its hosting platform's secret management (e.g. Supabase's own connection
-- role); the disposable integration-test harness in this session generates
-- a random password in memory per test run and applies it via
-- `ALTER ROLE samvardiq_app PASSWORD $1` immediately after migrating —
-- never written to disk.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samvardiq_app') THEN
    CREATE ROLE samvardiq_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO samvardiq_app;

-- Full DML on everything except the audit table.
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, goals, recommendations, approval_requests TO samvardiq_app;

-- approval_records: INSERT (governed transactions append records) and SELECT
-- (read the audit trail) only. No UPDATE, no DELETE — this is layer 1 of
-- immutability enforcement (see the trigger below for layer 2).
GRANT SELECT, INSERT ON approval_records TO samvardiq_app;

-- --------------------------------------------------------------------------
-- Row Level Security (organization isolation, defense-in-depth alongside
-- the application-level organization-scoped repository signatures).
--
-- Trusted context: the application sets `app.current_org_id` via
-- set_config('app.current_org_id', $1, true) — a parameterized function
-- call, not string-interpolated SQL — at the start of every transaction,
-- using the organizationId already passed into the calling repository
-- method. This protects against any code path that ISN'T the governed
-- repository adapter (a raw script, a future admin tool, a different
-- service using the same role). It does NOT yet protect against a caller
-- of the correct adapter supplying a false organizationId — that requires
-- a future authentication/session layer to resolve organizationId from a
-- verified identity before it ever reaches this adapter. Authentication
-- itself remains out of scope for this session.
--
-- FORCE ROW LEVEL SECURITY is enabled for portability: it has no effect
-- while the table owner is a superuser (which the migration-running role
-- is today), but ensures RLS still applies even to the owner role if a
-- future migration role is changed to a non-superuser owner.
-- --------------------------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_isolation ON organizations
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
CREATE POLICY goals_tenant_isolation ON goals
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY recommendations_tenant_isolation ON recommendations
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_requests_tenant_isolation ON approval_requests
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE approval_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_records FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_records_tenant_isolation ON approval_records
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

-- --------------------------------------------------------------------------
-- Referential integrity beyond plain foreign keys: approval_requests.goal_id
-- must equal the goal_id of the recommendation it references (a composite FK
-- to recommendations only guarantees "a valid recommendation in this org",
-- not "the goal_id you claimed matches that recommendation's actual goal").
-- The SELECT inside this function is itself subject to the recommendations
-- RLS policy above, so a mismatched/foreign organization context makes the
-- lookup return NULL and fail closed, reinforcing isolation rather than
-- bypassing it.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_approval_request_goal_consistency()
RETURNS TRIGGER AS $$
DECLARE
  actual_goal_id TEXT;
BEGIN
  SELECT goal_id INTO actual_goal_id
  FROM recommendations
  WHERE organization_id = NEW.organization_id
    AND recommendation_id = NEW.recommendation_id;

  IF actual_goal_id IS DISTINCT FROM NEW.goal_id THEN
    RAISE EXCEPTION 'approval_requests.goal_id (%) does not match recommendation %''s goal_id (%)',
      NEW.goal_id, NEW.recommendation_id, actual_goal_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_requests_goal_consistency
  BEFORE INSERT OR UPDATE ON approval_requests
  FOR EACH ROW
  EXECUTE FUNCTION enforce_approval_request_goal_consistency();

-- --------------------------------------------------------------------------
-- Approval-record immutability, layer 2: a trigger that unconditionally
-- rejects UPDATE/DELETE on approval_records. Unlike the GRANT revocation
-- above (which only restricts non-owner roles), a BEFORE trigger fires for
-- every role including the table owner/superuser — this is the "stronger,
-- role-independent" guarantee ADR-DATA-001 named as the eventual enterprise
-- posture, included now because it is cheap and directly satisfies amendment
-- 7's instruction to validate immutability against the actual runtime role
-- rather than assume GRANT revocation alone is sufficient.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_approval_record_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'approval_records rows are immutable and cannot be updated or deleted (attempted % on %.%)',
    TG_OP, OLD.organization_id, OLD.approval_record_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_records_immutable
  BEFORE UPDATE OR DELETE ON approval_records
  FOR EACH ROW
  EXECUTE FUNCTION prevent_approval_record_mutation();
