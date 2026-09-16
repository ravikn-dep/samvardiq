CREATE TABLE "communication_channels" (
	"organization_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_channel_id" text NOT NULL,
	"service_identity_id" text NOT NULL,
	"service_provider_subject" text NOT NULL,
	"access_token_reference" text NOT NULL,
	"display_phone_number" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communication_channels_organization_id_channel_id_pk" PRIMARY KEY("organization_id","channel_id"),
	CONSTRAINT "communication_channels_external_channel_id_unique" UNIQUE("external_channel_id")
);
--> statement-breakpoint
CREATE TABLE "communication_message_content" (
	"organization_id" text NOT NULL,
	"message_id" text NOT NULL,
	"raw_text" text NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	CONSTRAINT "communication_message_content_organization_id_message_id_pk" PRIMARY KEY("organization_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "communication_messages" (
	"organization_id" text NOT NULL,
	"message_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"direction" text NOT NULL,
	"external_message_id" text,
	"message_type" text NOT NULL,
	"structured_intent" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communication_messages_organization_id_message_id_pk" PRIMARY KEY("organization_id","message_id"),
	CONSTRAINT "communication_messages_direction_check" CHECK ("communication_messages"."direction" IN ('INBOUND','OUTBOUND'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"external_contact_id" text NOT NULL,
	"state" text NOT NULL,
	"preferred_language" text NOT NULL,
	"external_patient_id" text,
	"booking_state" text NOT NULL,
	"booking_consultant_id" text,
	"booking_date" text,
	"booking_slot" text,
	"booking_idempotency_key" text,
	"active_enquiry_id" text,
	"active_appointment_id" text,
	"handoff_trigger" text,
	"handoff_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_organization_id_conversation_id_pk" PRIMARY KEY("organization_id","conversation_id"),
	CONSTRAINT "conversations_channel_contact_unique" UNIQUE("organization_id","channel_id","external_contact_id"),
	CONSTRAINT "conversations_state_check" CHECK ("conversations"."state" IN ('AI_ACTIVE','HUMAN_HANDOFF_REQUESTED','HUMAN_ACTIVE','WAITING_FOR_PATIENT','RESOLVED','CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "webhook_event_dedup" (
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_event_dedup_provider_external_event_id_pk" PRIMARY KEY("provider","external_event_id")
);
