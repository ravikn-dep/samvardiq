CREATE TABLE "provider_oauth_authorizations" (
	"organization_id" text NOT NULL,
	"authorization_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"provider" text NOT NULL,
	"purpose" text NOT NULL,
	"identity_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_oauth_authorizations_organization_id_authorization_id_pk" PRIMARY KEY("organization_id","authorization_id"),
	CONSTRAINT "provider_oauth_authorizations_state_hash_key" UNIQUE("state_hash"),
	CONSTRAINT "provider_oauth_authorizations_state_hash_check" CHECK ("provider_oauth_authorizations"."state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "provider_oauth_authorizations_provider_check" CHECK ("provider_oauth_authorizations"."provider" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "provider_oauth_authorizations_purpose_check" CHECK ("provider_oauth_authorizations"."purpose" IN ('connect')),
	CONSTRAINT "provider_oauth_authorizations_redirect_check" CHECK (char_length("provider_oauth_authorizations"."redirect_uri") <= 2048 AND "provider_oauth_authorizations"."redirect_uri" ~ '^https?://'),
	CONSTRAINT "provider_oauth_authorizations_key_version_check" CHECK ("provider_oauth_authorizations"."key_version" > 0),
	CONSTRAINT "provider_oauth_authorizations_lifetime_check" CHECK ("provider_oauth_authorizations"."expires_at" > "provider_oauth_authorizations"."created_at" AND "provider_oauth_authorizations"."expires_at" <= "provider_oauth_authorizations"."created_at" + interval '15 minutes')
);
--> statement-breakpoint
-- GBP-W1 (Founder decision G2): provider-neutral, single-use OAuth state.
-- No secret is stored: the state only as SHA-256, and the PKCE verifier not at
-- all (re-derived from the master key ring). Consumption is DELETE ... RETURNING,
-- so the runtime role needs no UPDATE. No password is set here.
GRANT SELECT, INSERT, DELETE ON provider_oauth_authorizations TO samvardiq_app;

ALTER TABLE provider_oauth_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_oauth_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_oauth_authorizations_tenant_isolation ON provider_oauth_authorizations
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));
