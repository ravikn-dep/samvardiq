-- IDENTITY-W6: append-only enforcement, Row Level Security, and indexes for
-- identity_audit_events. Not expressible in Drizzle's schema DSL, hence
-- hand-written — same convention as
-- drizzle/0001_rls_membership_and_role.sql and data-foundation's
-- drizzle/0001_rls_and_roles.sql (approval_records immutability), which
-- this migration deliberately mirrors rather than reinvents.

-- --------------------------------------------------------------------------
-- Privileges: INSERT and SELECT only. No UPDATE, no DELETE — layer 1 of
-- immutability enforcement (see the trigger below for layer 2, which is
-- role-independent and therefore the stronger guarantee).
-- --------------------------------------------------------------------------

GRANT SELECT, INSERT ON identity_audit_events TO samvardiq_app;

-- --------------------------------------------------------------------------
-- Row Level Security.
--
-- identity_audit_events holds TWO kinds of rows, by design (see schema.ts):
--   - organization-scoped rows (MEMBERSHIP_* events): organization_id NOT NULL
--   - platform-global rows (IDENTITY_*/PROVIDER_LINK_* events): organization_id NULL
--
-- A naive "organization_id IS NULL -> visible to everyone" policy would be a
-- serious cross-tenant leak. Instead: a row is visible/insertable ONLY when
-- its own scope matches the CURRENT session's scope exactly —
--   - a tenant-scoped row requires app.current_org_id to be SET and equal
--   - a global row requires app.current_org_id to carry NO real org id
-- so a request running under any real tenant context (via
-- withOrganizationContext) can never see or create a global row, and a
-- global-event write (run with no org context at all) can never see or
-- create another organization's rows. Neither branch can ever match a
-- foreign organization's rows.
--
-- "No real org id" is deliberately checked as `COALESCE(..., '') = ''`, NOT
-- `IS NULL` — verified empirically during this session against real
-- PostgreSQL: `set_config('app.current_org_id', $1, true)` (LOCAL) resets,
-- at the end of the transaction that set it, to an EMPTY STRING on that
-- session for the rest of the connection's life in the pool — never back to
-- a true SQL NULL, because the custom GUC had no prior recorded value the
-- first time it was touched. A plain `IS NULL` check would therefore only
-- ever match a connection that had NEVER once run an organization-scoped
-- operation — silently breaking global-event writes/reads on any pooled
-- connection that had (a near-certainty in real, sustained traffic). Both
-- "genuinely never set" (NULL) and "reset after a prior LOCAL set" (empty
-- string) mean the same thing here — no real organization id is active —
-- and a real org id is, by construction, never an empty string.
-- --------------------------------------------------------------------------

ALTER TABLE identity_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY identity_audit_events_scope_isolation ON identity_audit_events
  USING (
    (organization_id IS NOT NULL AND organization_id = current_setting('app.current_org_id', true))
    OR (organization_id IS NULL AND COALESCE(current_setting('app.current_org_id', true), '') = '')
  )
  WITH CHECK (
    (organization_id IS NOT NULL AND organization_id = current_setting('app.current_org_id', true))
    OR (organization_id IS NULL AND COALESCE(current_setting('app.current_org_id', true), '') = '')
  );

-- --------------------------------------------------------------------------
-- Immutability, layer 2: unconditionally reject UPDATE/DELETE via a BEFORE
-- trigger, which fires for every role including the table owner/superuser —
-- the same "role-independent" guarantee already proven for approval_records.
-- Precise guarantee, stated accurately rather than overclaimed: this is
-- application-immutable / append-only under the runtime (samvardiq_app) role
-- and under this trigger. A database owner/superuser with DDL privileges
-- could still DROP or ALTER this trigger, or use a superuser bypass —
-- immutability is enforced against the application's own runtime access
-- path, not against a compromised database administrator.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_identity_audit_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'identity_audit_events rows are immutable and cannot be updated or deleted (attempted % on event %)',
    TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER identity_audit_events_immutable
  BEFORE UPDATE OR DELETE ON identity_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_identity_audit_event_mutation();

-- --------------------------------------------------------------------------
-- Indexes for practical security investigation (section 38). Exactly the
-- four query shapes a real investigation needs — not every possible index.
-- --------------------------------------------------------------------------

CREATE INDEX identity_audit_events_org_occurred_idx ON identity_audit_events (organization_id, occurred_at);
CREATE INDEX identity_audit_events_actor_occurred_idx ON identity_audit_events (actor_identity_id, occurred_at);
CREATE INDEX identity_audit_events_target_occurred_idx ON identity_audit_events (target_type, target_id, occurred_at);
CREATE INDEX identity_audit_events_type_occurred_idx ON identity_audit_events (event_type, occurred_at);
