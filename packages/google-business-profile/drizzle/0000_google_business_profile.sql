CREATE TABLE "gbp_location_bindings" (
	"organization_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"location_name" text NOT NULL,
	"account_name" text NOT NULL,
	"title" text NOT NULL,
	"bound_by_identity_id" text NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unbound_at" timestamp with time zone,
	"unbound_by_identity_id" text,
	"unbind_reason" text,
	CONSTRAINT "gbp_location_bindings_organization_id_binding_id_pk" PRIMARY KEY("organization_id","binding_id"),
	CONSTRAINT "gbp_location_bindings_provider_check" CHECK ("gbp_location_bindings"."provider" = 'google_business_profile'),
	CONSTRAINT "gbp_location_bindings_location_check" CHECK ("gbp_location_bindings"."location_name" ~ '^locations/[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "gbp_location_bindings_account_check" CHECK ("gbp_location_bindings"."account_name" ~ '^accounts/[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "gbp_location_bindings_title_check" CHECK (char_length("gbp_location_bindings"."title") <= 200),
	CONSTRAINT "gbp_location_bindings_reason_check" CHECK ("gbp_location_bindings"."unbind_reason" IN ('OWNER_UNBOUND','CONNECTION_DISCONNECTED','LOCATION_NOT_RETURNED')),
	CONSTRAINT "gbp_location_bindings_unbound_check" CHECK (("gbp_location_bindings"."unbound_at" IS NULL) = ("gbp_location_bindings"."unbind_reason" IS NULL) AND ("gbp_location_bindings"."unbound_at" IS NOT NULL OR "gbp_location_bindings"."unbound_by_identity_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "gbp_location_candidates" (
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"location_name" text NOT NULL,
	"account_name" text NOT NULL,
	"account_display_name" text NOT NULL,
	"title" text NOT NULL,
	"address_summary" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gbp_location_candidates_organization_id_connection_id_location_name_pk" PRIMARY KEY("organization_id","connection_id","location_name"),
	CONSTRAINT "gbp_location_candidates_provider_check" CHECK ("gbp_location_candidates"."provider" = 'google_business_profile'),
	CONSTRAINT "gbp_location_candidates_location_check" CHECK ("gbp_location_candidates"."location_name" ~ '^locations/[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "gbp_location_candidates_account_check" CHECK ("gbp_location_candidates"."account_name" ~ '^accounts/[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "gbp_location_candidates_metadata_check" CHECK (char_length("gbp_location_candidates"."title") <= 200 AND char_length("gbp_location_candidates"."account_display_name") <= 200 AND coalesce(char_length("gbp_location_candidates"."address_summary"), 0) <= 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gbp_location_bindings_active_location_key" ON "gbp_location_bindings" USING btree ("location_name") WHERE "gbp_location_bindings"."unbound_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "gbp_location_bindings_active_organization_key" ON "gbp_location_bindings" USING btree ("organization_id") WHERE "gbp_location_bindings"."unbound_at" IS NULL;--> statement-breakpoint
CREATE INDEX "gbp_location_bindings_connection_idx" ON "gbp_location_bindings" USING btree ("organization_id","connection_id");--> statement-breakpoint
-- GBP-W1 (Founder decisions G2/G3): binding persistence. Requires the
-- platform-credentials migration (ARCH-020 connections) to have run first —
-- the canonical migration chain orders it so. Hand-written below the
-- generated DDL, same convention as every other package. No password is set here.

-- Both tables reference the ARCH-020 connection through its
-- (organization_id, connection_id, provider) key, so a candidate or binding
-- can only belong to a Google Business Profile connection of its own organization.
ALTER TABLE gbp_location_candidates ADD CONSTRAINT gbp_location_candidates_connection_fkey
  FOREIGN KEY (organization_id, connection_id, provider)
  REFERENCES external_provider_connections (organization_id, connection_id, provider);
ALTER TABLE gbp_location_bindings ADD CONSTRAINT gbp_location_bindings_connection_fkey
  FOREIGN KEY (organization_id, connection_id, provider)
  REFERENCES external_provider_connections (organization_id, connection_id, provider);

-- G3 (W1 pilot restriction, not a permanent platform rule): at most one open
-- (not DISCONNECTED) Google Business Profile connection per organization.
-- Other providers are unaffected. Multi-account later = drop this index.
CREATE UNIQUE INDEX gbp_one_open_connection_per_organization ON external_provider_connections (organization_id)
  WHERE provider = 'google_business_profile' AND status <> 'DISCONNECTED';

-- Candidates are replaced wholesale on every OAuth completion: no UPDATE.
GRANT SELECT, INSERT, DELETE ON gbp_location_candidates TO samvardiq_app;

-- Bindings are history: never deleted by the runtime role; only the unbind columns change.
GRANT SELECT, INSERT ON gbp_location_bindings TO samvardiq_app;
GRANT UPDATE (unbound_at, unbound_by_identity_id, unbind_reason) ON gbp_location_bindings TO samvardiq_app;

ALTER TABLE gbp_location_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gbp_location_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY gbp_location_candidates_tenant_isolation ON gbp_location_candidates
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE gbp_location_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gbp_location_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY gbp_location_bindings_tenant_isolation ON gbp_location_bindings
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));
