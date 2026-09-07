CREATE TABLE "approval_records" (
	"organization_id" text NOT NULL,
	"approval_record_id" text NOT NULL,
	"approval_request_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"recommendation_id" text NOT NULL,
	"required_approval_level" smallint NOT NULL,
	"decision" text NOT NULL,
	"approver_id" text NOT NULL,
	"approver_role" text NOT NULL,
	"rationale" text,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"previous_state" text NOT NULL,
	"resulting_state" text NOT NULL,
	CONSTRAINT "approval_records_organization_id_approval_record_id_pk" PRIMARY KEY("organization_id","approval_record_id"),
	CONSTRAINT "approval_records_one_per_request" UNIQUE("organization_id","approval_request_id"),
	CONSTRAINT "approval_records_decision_check" CHECK ("approval_records"."decision" IN ('APPROVED','REJECTED','EXPIRED','CANCELLED')),
	CONSTRAINT "approval_records_level_check" CHECK ("approval_records"."required_approval_level" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"organization_id" text NOT NULL,
	"approval_request_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"recommendation_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"required_approval_level" smallint NOT NULL,
	"risk" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approval_requests_organization_id_approval_request_id_pk" PRIMARY KEY("organization_id","approval_request_id"),
	CONSTRAINT "approval_requests_status_check" CHECK ("approval_requests"."status" IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
	CONSTRAINT "approval_requests_level_check" CHECK ("approval_requests"."required_approval_level" BETWEEN 1 AND 5),
	CONSTRAINT "approval_requests_risk_check" CHECK ("approval_requests"."risk" IN ('low','moderate','high','critical'))
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"organization_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"owner_executive" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_organization_id_goal_id_pk" PRIMARY KEY("organization_id","goal_id"),
	CONSTRAINT "goals_status_check" CHECK ("goals"."status" IN ('active','completed','archived'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"organization_type" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"organization_id" text NOT NULL,
	"recommendation_id" text NOT NULL,
	"goal_id" text NOT NULL,
	"owning_executive" text NOT NULL,
	"originating_skill" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"approval_requirement" smallint NOT NULL,
	"risk" text NOT NULL,
	"evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendations_organization_id_recommendation_id_pk" PRIMARY KEY("organization_id","recommendation_id"),
	CONSTRAINT "recommendations_status_check" CHECK ("recommendations"."status" IN ('Draft','Ready for Approval','Awaiting Clarification','Rejected')),
	CONSTRAINT "recommendations_approval_requirement_check" CHECK ("recommendations"."approval_requirement" BETWEEN 1 AND 5),
	CONSTRAINT "recommendations_risk_check" CHECK ("recommendations"."risk" IN ('low','moderate','high','critical')),
	CONSTRAINT "recommendations_confidence_check" CHECK ("recommendations"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "approval_records" ADD CONSTRAINT "approval_records_request_fkey" FOREIGN KEY ("organization_id","approval_request_id") REFERENCES "public"."approval_requests"("organization_id","approval_request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_recommendation_fkey" FOREIGN KEY ("organization_id","recommendation_id") REFERENCES "public"."recommendations"("organization_id","recommendation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_goal_fkey" FOREIGN KEY ("organization_id","goal_id") REFERENCES "public"."goals"("organization_id","goal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_org_rec_idx" ON "approval_requests" USING btree ("organization_id","recommendation_id");--> statement-breakpoint
CREATE INDEX "approval_requests_org_status_idx" ON "approval_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "recommendations_org_goal_idx" ON "recommendations" USING btree ("organization_id","goal_id");