-- IDENTITY-W8: pre-organization self-discovery read path for
-- organization_memberships. Not expressible in Drizzle's schema DSL
-- (RLS policy replacement), hence hand-written — same convention as
-- drizzle/0001_rls_membership_and_role.sql and
-- drizzle/0003_identity_audit_events_security.sql.
--
-- Problem this solves (session brief section 7/8): a user must discover
-- WHICH organizations they belong to BEFORE selecting one, but
-- TrustedOrganizationContext (and the existing single
-- `organization_memberships_tenant_isolation` policy) requires an
-- organization to already be named. There was previously no way to ask
-- "list every membership row for identity X, across all organizations"
-- without either bypassing RLS (forbidden — see session brief section 9)
-- or scanning every organization one at a time (not possible without
-- already knowing the list).
--
-- Design: split the previous single FOR-ALL policy into three
-- command-specific policies. INSERT and UPDATE are carried over
-- UNCHANGED (byte-for-byte identical conditions to the policy they
-- replace) — this migration adds NO new write capability whatsoever.
-- Only SELECT gains a second, OR'd condition: a row is also readable
-- when the session's identity context (`app.current_identity_id`, a
-- NEW, separate GUC from `app.current_org_id`) matches that row's own
-- `identity_id`. This is a narrow, structural "can read my own rows,
-- across organizations" grant — never "can read this organization's
-- rows" (that remains gated by `app.current_org_id` exactly as before)
-- and never a path to constructing TrustedOrganizationContext (that
-- still requires the full AuthorizationService.resolveTrustedContext
-- flow — this migration only widens what a `SELECT` can see, not what
-- any application code treats as authorization).
--
-- Threat model: `app.current_identity_id` is set only by
-- `withIdentityContext` (postgres/client.ts), called only from
-- `PostgresMembershipRepository.listByIdentity`, called only with a
-- `identityId` already resolved from a verified provider credential
-- (see AuthorizationService) — never a raw client-supplied value. A
-- caller can therefore only ever see their OWN membership rows, never
-- another identity's, regardless of organization. No BYPASSRLS, no
-- FORCE ROW LEVEL SECURITY change, no "null context means see
-- everything" — the empty-string-after-reset behavior identified in
-- IDENTITY-W6 means an org-scoped operation (which never sets
-- app.current_identity_id) always evaluates the new OR-branch to false,
-- and a self-discovery operation (which never sets app.current_org_id)
-- always evaluates the original branch to false — the two mechanisms
-- cannot cross-contaminate.

DROP POLICY IF EXISTS organization_memberships_tenant_isolation ON organization_memberships;

CREATE POLICY organization_memberships_insert_isolation ON organization_memberships
  FOR INSERT
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

CREATE POLICY organization_memberships_update_isolation ON organization_memberships
  FOR UPDATE
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

CREATE POLICY organization_memberships_read_isolation ON organization_memberships
  FOR SELECT
  USING (
    organization_id = current_setting('app.current_org_id', true)
    OR identity_id = current_setting('app.current_identity_id', true)
  );
