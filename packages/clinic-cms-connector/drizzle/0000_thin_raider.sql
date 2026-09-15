CREATE TABLE "clinic_cms_connections" (
	"organization_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"base_url" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_reference" text NOT NULL,
	"approved_scopes" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_cms_connections_organization_id_connection_id_pk" PRIMARY KEY("organization_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "clinic_cms_connector_evidence" (
	"organization_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"operation" text NOT NULL,
	"correlation_id" text NOT NULL,
	"external_resource_type" text,
	"external_resource_id" text,
	"outcome" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"safe_error_category" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_cms_connector_evidence_organization_id_evidence_id_pk" PRIMARY KEY("organization_id","evidence_id"),
	CONSTRAINT "clinic_cms_connector_evidence_outcome_check" CHECK ("clinic_cms_connector_evidence"."outcome" IN ('SUCCESS','DENIED','ERROR'))
);
