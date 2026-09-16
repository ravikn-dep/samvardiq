-- CLINIC-W2B: application runtime role, Row Level Security. Not
-- expressible in Drizzle's schema DSL, hence hand-written — same
-- convention as every other package's own 0001_rls_and_roles.sql.
--
-- Reuses the same `samvardiq_app` role name every other package already
-- established. No password is set here and none is committed anywhere in
-- this repository — see those packages' own migrations for the identical
-- note on how a real deployment/test harness provisions it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samvardiq_app') THEN
    CREATE ROLE samvardiq_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO samvardiq_app;

-- communication_channels: platform-global (see schema.ts's own file-level
-- comment for why this table has no RLS at all — a channel lookup by
-- external_channel_id is HOW the organization gets determined, so it
-- cannot itself require that organization to already be known). No
-- UPDATE/DELETE grant — no code path in this package ever mutates or
-- removes a channel row; only `create` (provisioning) and read exist.
GRANT SELECT, INSERT ON communication_channels TO samvardiq_app;

-- webhook_event_dedup: platform-global (same reasoning as
-- identity_provider_links). No UPDATE — a dedup row is write-once.
GRANT SELECT, INSERT ON webhook_event_dedup TO samvardiq_app;

-- conversations: full read/write/update — a conversation's own state is
-- mutated throughout its lifecycle. No DELETE — conversations are never
-- removed by this package.
GRANT SELECT, INSERT, UPDATE ON conversations TO samvardiq_app;

-- communication_messages: append-only — no UPDATE/DELETE. A message,
-- once recorded (including its derived structured intent), is never
-- edited.
GRANT SELECT, INSERT ON communication_messages TO samvardiq_app;

-- communication_message_content: SELECT/INSERT for normal operation,
-- DELETE for the retention purge mechanism (retention.ts /
-- MessageContentRepository.purgeExpired) — no UPDATE, raw content is
-- never edited in place.
GRANT SELECT, INSERT, DELETE ON communication_message_content TO samvardiq_app;

-- --------------------------------------------------------------------------
-- Row Level Security — organization isolation for the three tables that
-- are always looked up AFTER an organization is already known
-- (conversations, communication_messages, communication_message_content).
-- Same `app.current_org_id` / set_config mechanism every other package's
-- RLS policy already relies on. FORCE ROW LEVEL SECURITY for portability,
-- matching every other package's own migration.
-- --------------------------------------------------------------------------

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_tenant_isolation ON conversations
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE communication_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_messages_tenant_isolation ON communication_messages
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

ALTER TABLE communication_message_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_message_content FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_message_content_tenant_isolation ON communication_message_content
  USING (organization_id = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id = current_setting('app.current_org_id', true));

-- communication_channels and webhook_event_dedup intentionally have NO
-- RLS policy — see schema.ts's own file-level comment and the GRANT
-- comments above for the full reasoning.
