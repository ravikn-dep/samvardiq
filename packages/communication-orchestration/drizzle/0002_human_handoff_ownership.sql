CREATE TABLE "conversation_handoffs" (
	"organization_id" text NOT NULL,
	"handoff_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_identity_id" text NOT NULL,
	"actor_principal_type" text NOT NULL,
	"outcome" text,
	"handoff_trigger" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_handoffs_organization_id_handoff_id_pk" PRIMARY KEY("organization_id","handoff_id"),
	CONSTRAINT "conversation_handoffs_event_type_check" CHECK ("conversation_handoffs"."event_type" IN ('CLAIMED','RESOLVED','REOPENED')),
	CONSTRAINT "conversation_handoffs_actor_check" CHECK ("conversation_handoffs"."actor_principal_type" IN ('human','service')),
	CONSTRAINT "conversation_handoffs_outcome_check" CHECK (("conversation_handoffs"."event_type" = 'RESOLVED') = ("conversation_handoffs"."outcome" IS NOT NULL) AND ("conversation_handoffs"."outcome" IS NULL OR "conversation_handoffs"."outcome" IN ('RETURN_TO_AI','CLOSE'))),
	CONSTRAINT "conversation_handoffs_actor_semantics_check" CHECK (("conversation_handoffs"."event_type" = 'REOPENED') = ("conversation_handoffs"."actor_principal_type" = 'service'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handoff_owner_identity_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "handoff_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_handoffs" ADD CONSTRAINT "conversation_handoffs_organization_id_conversation_id_conversations_organization_id_conversation_id_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_handoffs_conversation_idx" ON "conversation_handoffs" USING btree ("organization_id","conversation_id","occurred_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_handoff_owner_check" CHECK (("conversations"."state" = 'HUMAN_ACTIVE') = ("conversations"."handoff_owner_identity_id" IS NOT NULL AND "conversations"."handoff_claimed_at" IS NOT NULL)
          AND ("conversations"."handoff_owner_identity_id" IS NULL) = ("conversations"."handoff_claimed_at" IS NULL));--> statement-breakpoint
-- CLINIC-W2D: grants, Row Level Security and immutability for the append-only
-- handoff log. Not expressible in Drizzle's schema DSL, hence hand-written
-- below the generated DDL — mirrors identity-access's
-- 0003_identity_audit_events_security.sql rather than reinventing it.
--
-- conversations needs no new grant: samvardiq_app already holds
-- SELECT/INSERT/UPDATE on it (0001), and the new ownership columns are
-- covered by the existing conversations_tenant_isolation policy.

-- Layer 1 of immutability: INSERT and SELECT only, no UPDATE/DELETE.
GRANT SELECT, INSERT ON conversation_handoffs TO samvardiq_app;

ALTER TABLE conversation_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_handoffs_tenant_isolation ON conversation_handoffs
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

-- Layer 2: reject UPDATE/DELETE for every role, including the owner. As with
-- identity_audit_events, this binds the application's runtime access path,
-- not a database administrator able to drop the trigger.
CREATE OR REPLACE FUNCTION prevent_conversation_handoff_mutation()
RETURNS TRIGGER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'conversation_handoffs rows are immutable and cannot be updated or deleted (attempted % on handoff %)',
    TG_OP, OLD.handoff_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_handoffs_immutable
  BEFORE UPDATE OR DELETE ON conversation_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_conversation_handoff_mutation();
