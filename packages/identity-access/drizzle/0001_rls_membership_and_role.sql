-- IDENTITY-W2: application runtime role and Row Level Security for the one
-- organization-scoped table in this package. `identities` and
-- `identity_provider_links` are platform-global and intentionally get no
-- RLS — see src/postgres/schema.ts.
--
-- Reuses the same `samvardiq_app` role name DATA-W3 already established.
-- In a real deployment both packages' migrations run against the same
-- physical database, so this must be idempotent regardless of which
-- migration chain runs first — whichever runs first creates the role, the
-- second is a no-op. No password is set here; see DATA-W3's identical
-- convention (drizzle/0001_rls_and_roles.sql in data-foundation) — a real
-- deployment provisions that credential through hosting-platform secret
-- management, and this session's disposable test harness generates a
-- random password in memory per run, never written to disk.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samvardiq_app') THEN
    CREATE ROLE samvardiq_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO samvardiq_app;

-- identities / identity_provider_links: platform-global, no RLS. No DELETE
-- grant on either — an identity is deactivated via status transition, never
-- deleted; a provider link, once created, is not expected to be mutated.
GRANT SELECT, INSERT, UPDATE ON identities TO samvardiq_app;
GRANT SELECT, INSERT ON identity_provider_links TO samvardiq_app;

-- organization_memberships: the one RLS-protected table here. No DELETE —
-- revocation is a status transition (REVOKED), not row deletion, consistent
-- with the no-silent-loss posture DATA-W3 already established.
GRANT SELECT, INSERT, UPDATE ON organization_memberships TO samvardiq_app;

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_memberships_tenant_isolation ON organization_memberships
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));
