CREATE TABLE "external_provider_connections" (
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text,
	"status" text NOT NULL,
	"granted_scopes" jsonb NOT NULL,
	"connected_by_identity_id" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_provider_connections_organization_id_connection_id_pk" PRIMARY KEY("organization_id","connection_id"),
	CONSTRAINT "external_provider_connections_provider_key" UNIQUE("organization_id","connection_id","provider"),
	CONSTRAINT "external_provider_connections_status_check" CHECK ("external_provider_connections"."status" IN ('ACTIVE','NEEDS_REAUTH','DISCONNECTED')),
	CONSTRAINT "external_provider_connections_disconnected_check" CHECK (("external_provider_connections"."status" = 'DISCONNECTED') = ("external_provider_connections"."disconnected_at" IS NOT NULL)),
	CONSTRAINT "external_provider_connections_provider_check" CHECK ("external_provider_connections"."provider" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "external_provider_connections_scopes_check" CHECK (jsonb_typeof("external_provider_connections"."granted_scopes") = 'array')
);
--> statement-breakpoint
CREATE TABLE "external_provider_credential_events" (
	"organization_id" text NOT NULL,
	"event_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"credential_id" text,
	"event_type" text NOT NULL,
	"actor_principal_type" text NOT NULL,
	"actor_identity_id" text,
	"key_version" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_provider_credential_events_organization_id_event_id_pk" PRIMARY KEY("organization_id","event_id"),
	CONSTRAINT "external_provider_credential_events_type_check" CHECK ("external_provider_credential_events"."event_type" IN ('CONNECTION_CREATED','CREDENTIAL_STORED','CREDENTIAL_REPLACED','CREDENTIAL_REWRAPPED','CONNECTION_NEEDS_REAUTH','CONNECTION_DISCONNECTED','CREDENTIAL_DELETED')),
	CONSTRAINT "external_provider_credential_events_actor_check" CHECK (("external_provider_credential_events"."actor_principal_type" IN ('human','service') AND "external_provider_credential_events"."actor_identity_id" IS NOT NULL)
          OR ("external_provider_credential_events"."actor_principal_type" = 'system' AND "external_provider_credential_events"."actor_identity_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "external_provider_credentials" (
	"organization_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"credential_type" text NOT NULL,
	"algorithm" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"payload_nonce" "bytea" NOT NULL,
	"payload_tag" "bytea" NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"wrap_nonce" "bytea" NOT NULL,
	"wrap_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"key_check" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "external_provider_credentials_organization_id_credential_id_pk" PRIMARY KEY("organization_id","credential_id"),
	CONSTRAINT "external_provider_credentials_connection_type_key" UNIQUE("organization_id","connection_id","credential_type"),
	CONSTRAINT "external_provider_credentials_type_check" CHECK ("external_provider_credentials"."credential_type" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "external_provider_credentials_algorithm_check" CHECK ("external_provider_credentials"."algorithm" = 'AES-256-GCM'),
	CONSTRAINT "external_provider_credentials_envelope_check" CHECK (octet_length("external_provider_credentials"."ciphertext") BETWEEN 1 AND 16384
          AND octet_length("external_provider_credentials"."payload_nonce") = 12 AND octet_length("external_provider_credentials"."payload_tag") = 16
          AND octet_length("external_provider_credentials"."wrapped_key") = 32 AND octet_length("external_provider_credentials"."wrap_nonce") = 12 AND octet_length("external_provider_credentials"."wrap_tag") = 16
          AND octet_length("external_provider_credentials"."key_check") = 16 AND "external_provider_credentials"."key_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "external_provider_credential_events" ADD CONSTRAINT "external_provider_credential_events_connection_fkey" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."external_provider_connections"("organization_id","connection_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_provider_credentials" ADD CONSTRAINT "external_provider_credentials_connection_fkey" FOREIGN KEY ("organization_id","connection_id","provider") REFERENCES "public"."external_provider_connections"("organization_id","connection_id","provider") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_provider_credential_events_connection_idx" ON "external_provider_credential_events" USING btree ("organization_id","connection_id","occurred_at");--> statement-breakpoint
CREATE INDEX "external_provider_credentials_key_version_idx" ON "external_provider_credentials" USING btree ("key_version");--> statement-breakpoint
-- PLATFORM-CREDENTIALS-W1 (ARCH-020): runtime role, minimum grants, Row Level
-- Security and audit immutability. Not expressible in Drizzle's schema DSL,
-- hence hand-written below the generated DDL — same convention as every
-- other package's RLS migration. No password is set here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samvardiq_app') THEN
    CREATE ROLE samvardiq_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO samvardiq_app;

-- Connections: never deleted (they are the audit anchor). Only lifecycle
-- columns are updatable; organization, provider, connection ID and who
-- connected it are immutable to the runtime role.
GRANT SELECT, INSERT ON external_provider_connections TO samvardiq_app;
GRANT UPDATE (status, external_account_id, granted_scopes, disconnected_at, updated_at) ON external_provider_connections TO samvardiq_app;

-- Credentials: INSERT (store), SELECT (use), DELETE (replace/disconnect), and
-- UPDATE only of the wrapped-key columns (rotation). The ciphertext and its
-- identity columns can never be rewritten in place — a replacement is always
-- delete + insert under a new credential ID.
GRANT SELECT, INSERT, DELETE ON external_provider_credentials TO samvardiq_app;
GRANT UPDATE (wrapped_key, wrap_nonce, wrap_tag, key_version, key_check, rotated_at) ON external_provider_credentials TO samvardiq_app;

-- Audit: append-only, layer 1 (no UPDATE/DELETE grant).
GRANT SELECT, INSERT ON external_provider_credential_events TO samvardiq_app;

ALTER TABLE external_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_provider_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY external_provider_connections_tenant_isolation ON external_provider_connections
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE external_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_provider_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY external_provider_credentials_tenant_isolation ON external_provider_credentials
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE external_provider_credential_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_provider_credential_events FORCE ROW LEVEL SECURITY;
CREATE POLICY external_provider_credential_events_tenant_isolation ON external_provider_credential_events
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

-- Audit immutability, layer 2: rejects UPDATE/DELETE for every role including
-- the owner (mirrors prevent_conversation_handoff_mutation). Binds the
-- application's access path, not an administrator able to drop the trigger.
CREATE OR REPLACE FUNCTION prevent_credential_event_mutation()
RETURNS TRIGGER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'external_provider_credential_events rows are immutable and cannot be updated or deleted (attempted % on event %)',
    TG_OP, OLD.event_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER external_provider_credential_events_immutable
  BEFORE UPDATE OR DELETE ON external_provider_credential_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_credential_event_mutation();
