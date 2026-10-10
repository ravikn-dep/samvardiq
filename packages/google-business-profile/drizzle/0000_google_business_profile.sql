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
	"access_lost_at" timestamp with time zone,
	CONSTRAINT "gbp_location_bindings_organization_id_binding_id_pk" PRIMARY KEY("organization_id","binding_id"),
	CONSTRAINT "gbp_location_bindings_provider_check" CHECK ("gbp_location_bindings"."provider" = 'google_business_profile'),
	CONSTRAINT "gbp_location_bindings_location_check" CHECK ("gbp_location_bindings"."location_name" ~ '^locations/[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "gbp_location_bindings_account_check" CHECK ("gbp_location_bindings"."account_name" ~ '^accounts/[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "gbp_location_bindings_title_check" CHECK (char_length("gbp_location_bindings"."title") <= 200),
	CONSTRAINT "gbp_location_bindings_reason_check" CHECK ("gbp_location_bindings"."unbind_reason" IN ('OWNER_UNBOUND','CONNECTION_DISCONNECTED')),
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
CREATE TABLE "gbp_operation_events" (
	"organization_id" text NOT NULL,
	"event_id" text NOT NULL,
	"request_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"phase" text NOT NULL,
	"actor_principal_type" text NOT NULL,
	"actor_identity_id" text NOT NULL,
	"failure_class" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gbp_operation_events_organization_id_event_id_pk" PRIMARY KEY("organization_id","event_id"),
	CONSTRAINT "gbp_operation_events_provider_check" CHECK ("gbp_operation_events"."provider" = 'google_business_profile'),
	CONSTRAINT "gbp_operation_events_operation_check" CHECK ("gbp_operation_events"."operation" IN ('GBP_DISCOVER_LOCATIONS','GBP_VERIFY_CONNECTION','GBP_REVOKE_CONNECTION')),
	CONSTRAINT "gbp_operation_events_phase_check" CHECK ("gbp_operation_events"."phase" IN ('REQUESTED','SUCCEEDED','FAILED')),
	CONSTRAINT "gbp_operation_events_actor_check" CHECK (("gbp_operation_events"."phase" = 'REQUESTED') = ("gbp_operation_events"."actor_principal_type" = 'human') AND "gbp_operation_events"."actor_principal_type" IN ('human','service')),
	CONSTRAINT "gbp_operation_events_failure_check" CHECK (("gbp_operation_events"."phase" = 'FAILED') = ("gbp_operation_events"."failure_class" IS NOT NULL) AND coalesce("gbp_operation_events"."failure_class" ~ '^[a-z][a-z0-9_]{1,63}$', true))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gbp_location_bindings_active_location_key" ON "gbp_location_bindings" USING btree ("location_name") WHERE "gbp_location_bindings"."unbound_at" IS NULL;--> statement-breakpoint
CREATE INDEX "gbp_location_bindings_connection_idx" ON "gbp_location_bindings" USING btree ("organization_id","connection_id");--> statement-breakpoint
CREATE INDEX "gbp_operation_events_request_idx" ON "gbp_operation_events" USING btree ("organization_id","request_id");--> statement-breakpoint
-- GBP-W1 (Founder decisions G1-G3, 2026-10-10): binding persistence and the
-- operation audit. Requires the platform-credentials migrations (ARCH-020
-- connections) to have run first — the canonical migration chain orders it so.
-- Hand-written below the generated DDL, same convention as every other
-- package. No password is set here.

-- Every table references the ARCH-020 connection through its
-- (organization_id, connection_id, provider) key, so a candidate, binding or
-- operation event can only belong to a Google Business Profile connection of
-- its own organization.
ALTER TABLE gbp_location_candidates ADD CONSTRAINT gbp_location_candidates_connection_fkey
  FOREIGN KEY (organization_id, connection_id, provider)
  REFERENCES external_provider_connections (organization_id, connection_id, provider);
ALTER TABLE gbp_location_bindings ADD CONSTRAINT gbp_location_bindings_connection_fkey
  FOREIGN KEY (organization_id, connection_id, provider)
  REFERENCES external_provider_connections (organization_id, connection_id, provider);
ALTER TABLE gbp_operation_events ADD CONSTRAINT gbp_operation_events_connection_fkey
  FOREIGN KEY (organization_id, connection_id, provider)
  REFERENCES external_provider_connections (organization_id, connection_id, provider);

-- G3 (the GBP-W1 operational constraint, not a permanent platform rule): at
-- most one open (not DISCONNECTED) Google Business Profile connection per
-- organization. Other providers are unaffected; several connections later =
-- drop this index (bindings already reference their connection).
CREATE UNIQUE INDEX gbp_one_open_connection_per_organization ON external_provider_connections (organization_id)
  WHERE provider = 'google_business_profile' AND status <> 'DISCONNECTED';

-- Candidates are replaced wholesale on every discovery: no UPDATE.
GRANT SELECT, INSERT, DELETE ON gbp_location_candidates TO samvardiq_app;

-- Bindings are history: never deleted by the runtime role; only the unbind and access-state columns change.
GRANT SELECT, INSERT ON gbp_location_bindings TO samvardiq_app;
GRANT UPDATE (unbound_at, unbound_by_identity_id, unbind_reason, access_lost_at) ON gbp_location_bindings TO samvardiq_app;

-- Operation audit: append-only, immutable even for the table owner (same pattern as external_provider_credential_events).
GRANT SELECT, INSERT ON gbp_operation_events TO samvardiq_app;

CREATE OR REPLACE FUNCTION prevent_gbp_operation_event_mutation()
RETURNS TRIGGER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'gbp_operation_events rows are immutable and cannot be updated or deleted (attempted % on event %)',
    TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gbp_operation_events_immutable
  BEFORE UPDATE OR DELETE ON gbp_operation_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_gbp_operation_event_mutation();

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

ALTER TABLE gbp_operation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gbp_operation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY gbp_operation_events_tenant_isolation ON gbp_operation_events
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));
