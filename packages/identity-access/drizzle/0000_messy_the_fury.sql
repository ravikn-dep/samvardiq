CREATE TABLE "identities" (
	"identity_id" text PRIMARY KEY NOT NULL,
	"principal_type" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_principal_type_check" CHECK ("identities"."principal_type" IN ('human','service')),
	CONSTRAINT "identities_status_check" CHECK ("identities"."status" IN ('active','suspended','revoked'))
);
--> statement-breakpoint
CREATE TABLE "identity_provider_links" (
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"identity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_provider_links_provider_provider_subject_pk" PRIMARY KEY("provider","provider_subject")
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"organization_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"role" text NOT NULL,
	"approver_role" text,
	"status" text NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_organization_id_identity_id_pk" PRIMARY KEY("organization_id","identity_id"),
	CONSTRAINT "organization_memberships_role_check" CHECK ("organization_memberships"."role" IN ('OWNER','MEMBER','VIEWER')),
	CONSTRAINT "organization_memberships_approver_role_check" CHECK ("organization_memberships"."approver_role" IS NULL OR "organization_memberships"."approver_role" IN ('hr_manager','marketing_manager','operations_manager','finance_manager','clinic_director','founder')),
	CONSTRAINT "organization_memberships_status_check" CHECK ("organization_memberships"."status" IN ('INVITED','ACTIVE','SUSPENDED','REVOKED'))
);
--> statement-breakpoint
ALTER TABLE "identity_provider_links" ADD CONSTRAINT "identity_provider_links_identity_fkey" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_identity_fkey" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("identity_id") ON DELETE no action ON UPDATE no action;