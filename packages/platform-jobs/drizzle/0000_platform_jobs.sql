CREATE TABLE "platform_jobs" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"organization_id" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"lease_id" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_failure_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_jobs_idempotency_key" UNIQUE("job_type","idempotency_key"),
	CONSTRAINT "platform_jobs_status_check" CHECK ("platform_jobs"."status" IN ('PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','DEAD')),
	CONSTRAINT "platform_jobs_type_check" CHECK ("platform_jobs"."job_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND char_length("platform_jobs"."job_type") <= 64),
	CONSTRAINT "platform_jobs_key_check" CHECK (char_length("platform_jobs"."idempotency_key") BETWEEN 1 AND 200),
	CONSTRAINT "platform_jobs_payload_check" CHECK (jsonb_typeof("platform_jobs"."payload") = 'object' AND octet_length("platform_jobs"."payload"::text) <= 1024),
	CONSTRAINT "platform_jobs_attempts_check" CHECK ("platform_jobs"."attempts" >= 0 AND "platform_jobs"."max_attempts" BETWEEN 1 AND 25 AND "platform_jobs"."attempts" <= "platform_jobs"."max_attempts"),
	CONSTRAINT "platform_jobs_lease_check" CHECK (("platform_jobs"."status" = 'RUNNING') = ("platform_jobs"."lease_id" IS NOT NULL AND "platform_jobs"."lease_owner" IS NOT NULL AND "platform_jobs"."lease_expires_at" IS NOT NULL)
          AND ("platform_jobs"."lease_id" IS NULL) = ("platform_jobs"."lease_owner" IS NULL) AND ("platform_jobs"."lease_id" IS NULL) = ("platform_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "platform_jobs_finished_check" CHECK (("platform_jobs"."status" IN ('SUCCEEDED','DEAD')) = ("platform_jobs"."finished_at" IS NOT NULL)),
	CONSTRAINT "platform_jobs_failure_class_check" CHECK ("platform_jobs"."last_failure_class" IS NULL OR "platform_jobs"."last_failure_class" ~ '^[a-z][a-z0-9_]{0,62}$')
);
--> statement-breakpoint
CREATE INDEX "platform_jobs_due_idx" ON "platform_jobs" USING btree ("status","run_after");--> statement-breakpoint
-- PLATFORM-JOBS-W1 (ARCH-021): runtime role and minimum grants. Not
-- expressible in Drizzle's schema DSL, hence hand-written below the
-- generated DDL. No password is set here.
--
-- platform_jobs is PLATFORM-GLOBAL operational data holding identifiers only
-- (ADR-PLATFORM-002 "Tenant isolation and authority"), the same category as
-- communication_channels / webhook_event_dedup: like them it carries no
-- tenant RLS policy in this migration; on Supabase the platform hardening
-- step enables RLS with the samvardiq_app-scoped policy (PLATFORM_GLOBAL_TABLES).
-- A job grants no tenant access: consumers re-resolve authority and touch
-- tenant data only through their own organization-scoped, RLS-protected paths.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samvardiq_app') THEN
    CREATE ROLE samvardiq_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO samvardiq_app;

-- Enqueue (INSERT), claim/observe (SELECT), and lifecycle transitions only:
-- the job's identity, type, organization, idempotency key, payload, attempt
-- ceiling and creation time are immutable to the runtime role. No DELETE —
-- DEAD and SUCCEEDED jobs are retained for diagnosis (pruning is a later,
-- separately governed operation).
GRANT SELECT, INSERT ON platform_jobs TO samvardiq_app;
GRANT UPDATE (status, run_after, attempts, lease_id, lease_owner, lease_expires_at, last_failure_class, started_at, finished_at, updated_at) ON platform_jobs TO samvardiq_app;
