CREATE TABLE "identity_audit_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"actor_identity_id" text,
	"actor_principal_type" text NOT NULL,
	"event_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_audit_events_actor_principal_type_check" CHECK ("identity_audit_events"."actor_principal_type" IN ('human','service','system')),
	CONSTRAINT "identity_audit_events_actor_consistency_check" CHECK (("identity_audit_events"."actor_principal_type" = 'system' AND "identity_audit_events"."actor_identity_id" IS NULL) OR ("identity_audit_events"."actor_principal_type" IN ('human','service') AND "identity_audit_events"."actor_identity_id" IS NOT NULL)),
	CONSTRAINT "identity_audit_events_event_type_check" CHECK ("identity_audit_events"."event_type" IN ('IDENTITY_CREATED','IDENTITY_STATUS_CHANGED','PROVIDER_LINK_CREATED','PROVIDER_LINK_REMOVED','MEMBERSHIP_CREATED','MEMBERSHIP_STATUS_CHANGED','MEMBERSHIP_ROLE_CHANGED','AUTHENTICATION_FAILED','AUTHORIZATION_FAILED')),
	CONSTRAINT "identity_audit_events_organization_scope_check" CHECK (("identity_audit_events"."event_type" IN ('MEMBERSHIP_CREATED','MEMBERSHIP_STATUS_CHANGED','MEMBERSHIP_ROLE_CHANGED') AND "identity_audit_events"."organization_id" IS NOT NULL) OR ("identity_audit_events"."event_type" IN ('IDENTITY_CREATED','IDENTITY_STATUS_CHANGED','PROVIDER_LINK_CREATED','PROVIDER_LINK_REMOVED') AND "identity_audit_events"."organization_id" IS NULL) OR "identity_audit_events"."event_type" IN ('AUTHENTICATION_FAILED','AUTHORIZATION_FAILED')),
	CONSTRAINT "identity_audit_events_target_type_check" CHECK ("identity_audit_events"."target_type" IN ('IDENTITY','MEMBERSHIP','PROVIDER_LINK')),
	CONSTRAINT "identity_audit_events_outcome_check" CHECK ("identity_audit_events"."outcome" IN ('SUCCESS','DENIED','FAILED')),
	CONSTRAINT "identity_audit_events_reason_length_check" CHECK ("identity_audit_events"."reason" IS NULL OR char_length("identity_audit_events"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "identity_audit_events" ADD CONSTRAINT "identity_audit_events_actor_identity_fkey" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."identities"("identity_id") ON DELETE no action ON UPDATE no action;