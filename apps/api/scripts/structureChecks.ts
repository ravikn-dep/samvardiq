/**
 * INFRA-W1B — read-only structural verification of a migrated Samvardiq
 * database: physical schema, independently recomputed migration journals,
 * runtime-role privileges, triggers, RLS/FORCE RLS, and the Supabase
 * default-role exposure review. Issues only SELECTs against catalogs.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MIGRATION_STEPS } from './migrationChain.js';
import { CLIENT_FACING_ROLES, OWN_FUNCTIONS, PLATFORM_GLOBAL_POLICY, PLATFORM_GLOBAL_TABLES } from './supabaseHardening.js';
import { Reporter, type AdminPostgres } from './stagingDb.js';

export const EXPECTED_TABLES = [
  'approval_records', 'approval_requests', 'clinic_cms_connections', 'clinic_cms_connector_evidence', 'communication_channels',
  'communication_message_content', 'communication_messages', 'conversations', 'goals', 'identities', 'identity_audit_events',
  'identity_provider_links', 'organization_memberships', 'organizations', 'recommendations', 'webhook_event_dedup',
] as const;

/** Tenant-scoped tables: FORCE RLS + at least one policy keyed on the organization (or, for memberships, identity) GUC. */
export const TENANT_TABLES = EXPECTED_TABLES.filter((t) => !(PLATFORM_GLOBAL_TABLES as readonly string[]).includes(t));

/** Exact DML the runtime role may hold per table — transcribed from each package's `*_rls*.sql` GRANT statements. */
export const EXPECTED_APP_PRIVILEGES: Record<string, string> = {
  approval_records: 'INSERT,SELECT',
  approval_requests: 'DELETE,INSERT,SELECT,UPDATE',
  clinic_cms_connections: 'INSERT,SELECT,UPDATE',
  clinic_cms_connector_evidence: 'INSERT,SELECT',
  communication_channels: 'INSERT,SELECT',
  communication_message_content: 'DELETE,INSERT,SELECT',
  communication_messages: 'INSERT,SELECT',
  conversations: 'INSERT,SELECT,UPDATE',
  goals: 'DELETE,INSERT,SELECT,UPDATE',
  identities: 'INSERT,SELECT,UPDATE',
  identity_audit_events: 'INSERT,SELECT',
  identity_provider_links: 'INSERT,SELECT',
  organization_memberships: 'INSERT,SELECT,UPDATE',
  organizations: 'DELETE,INSERT,SELECT,UPDATE',
  recommendations: 'DELETE,INSERT,SELECT,UPDATE',
  webhook_event_dedup: 'INSERT,SELECT',
};

export const EXPECTED_JOURNALS: Record<string, { schema: string; migrations: number }> = {
  'data-foundation': { schema: 'drizzle_data_foundation', migrations: 2 },
  'identity-access': { schema: 'drizzle_identity_access', migrations: 5 },
  'clinic-cms-connector': { schema: 'drizzle_clinic_cms_connector', migrations: 3 },
  'communication-orchestration': { schema: 'drizzle_communication_orchestration', migrations: 2 },
};

export const EXPECTED_TRIGGERS = [
  { table: 'approval_requests', name: 'approval_requests_goal_consistency', fn: 'enforce_approval_request_goal_consistency' },
  { table: 'approval_records', name: 'approval_records_immutable', fn: 'prevent_approval_record_mutation' },
  { table: 'identity_audit_events', name: 'identity_audit_events_immutable', fn: 'prevent_identity_audit_event_mutation' },
] as const;

const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

type Rows = Record<string, unknown>[];
const rowsOf = async (admin: AdminPostgres, text: string, params: unknown[] = []): Promise<Rows> => (await admin.pool.query(text, params)).rows as Rows;
const n = (value: unknown): number => Number(value);

/** Recomputes each journal row independently of drizzle's migrator: sha256(sql file) + the journal's own `when`. */
export function expectedJournalEntries(migrationsFolder: string): { hash: string; createdAt: string }[] {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  return journal.entries.map((entry) => ({
    hash: crypto.createHash('sha256').update(fs.readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf8')).digest('hex'),
    createdAt: String(entry.when),
  }));
}

/**
 * Can the admin role `SET ROLE samvardiq_app`? pg_has_role is authoritative for a non-superuser (Supabase's `postgres`). A superuser
 * (only the local rehearsal cluster) passes every pg_has_role check, so there the explicit SET-option membership edge is what is measured.
 */
export async function adminCanSetRuntimeRole(admin: AdminPostgres): Promise<boolean> {
  const rows = await rowsOf(
    admin,
    `select case when (select rolsuper from pg_roles where rolname = current_user)
                 then exists (select 1 from pg_auth_members m where m.roleid = 'samvardiq_app'::regrole and m.member = (select oid from pg_roles where rolname = current_user) and m.set_option)
                 else pg_has_role(current_user, 'samvardiq_app', 'SET') end as v`,
  );
  return rows[0]!.v === true;
}

/** Exact set of table privileges `samvardiq_app` holds on each public table, e.g. { goals: 'DELETE,INSERT,SELECT,UPDATE' }. */
export async function appPrivilegeMatrix(admin: AdminPostgres): Promise<Record<string, string>> {
  const matrix: Record<string, string> = {};
  for (const table of EXPECTED_TABLES) {
    const held = await Promise.all(TABLE_PRIVS.map(async (priv) => ((await rowsOf(admin, `select has_table_privilege('samvardiq_app', $1, $2) as ok`, [`public.${table}`, priv]))[0]!.ok ? priv : null)));
    matrix[table] = held.filter((priv): priv is (typeof TABLE_PRIVS)[number] => priv !== null).sort().join(',');
  }
  return matrix;
}

export async function runStructureChecks(admin: AdminPostgres, reporter: Reporter): Promise<void> {
  await reporter.check('S1 physical tables: exactly the 16 expected, no views/matviews/foreign tables', async () => {
    const tables = (await rowsOf(admin, `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).map((r) => r.table_name);
    assert.deepEqual(tables, [...EXPECTED_TABLES]);
    const other = await rowsOf(admin, `select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and c.relkind in ('v','m','f','p')`);
    assert.equal(other.length, 0, 'no views/materialized views/foreign/partitioned tables in public');
    return `${tables.length} tables`;
  });

  await reporter.check('S2 migration journals: per-package schema, count, and independently recomputed sha256+timestamp per row', async () => {
    const details: string[] = [];
    for (const step of MIGRATION_STEPS) {
      const expected = EXPECTED_JOURNALS[step.packageName]!;
      const local = expectedJournalEntries(step.migrationsFolder);
      const remote = await rowsOf(admin, `select hash, created_at::text as created_at from ${expected.schema}.__drizzle_migrations order by created_at`);
      assert.equal(remote.length, expected.migrations, `${step.packageName}: journal row count`);
      assert.deepEqual(
        remote.map((r) => ({ hash: r.hash, createdAt: r.created_at })),
        local,
        `${step.packageName}: remote journal rows must equal sha256/when recomputed from the repository's own SQL files`,
      );
      details.push(`${expected.schema}=${remote.length}`);
    }
    const shared = await rowsOf(admin, `select to_regclass('drizzle.__drizzle_migrations') as r`);
    assert.equal(shared[0]!.r, null, 'the old shared drizzle.__drizzle_migrations journal must not exist');
    return details.join(', ');
  });

  await reporter.check('S3 runtime role samvardiq_app: exactly one, all dangerous attributes false, no role memberships, no CREATE on public/database', async () => {
    const roles = await rowsOf(admin, `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin, rolinherit from pg_roles where rolname = 'samvardiq_app'`);
    assert.equal(roles.length, 1);
    assert.deepEqual(
      { ...roles[0] },
      { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false, rolcanlogin: true, rolinherit: true },
    );
    const memberOf = await rowsOf(admin, `select count(*)::int as n from pg_auth_members where member = 'samvardiq_app'::regrole`);
    assert.equal(n(memberOf[0]!.n), 0, 'samvardiq_app is a member of no role');
    const create = await rowsOf(admin, `select has_schema_privilege('samvardiq_app','public','CREATE') as schema_create, has_database_privilege('samvardiq_app', current_database(), 'CREATE') as db_create`);
    assert.deepEqual({ ...create[0] }, { schema_create: false, db_create: false });
    return 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION; LOGIN by design (password never set by migrations)';
  });

  await reporter.check('S8 no leftover temporary access: the admin role cannot SET ROLE samvardiq_app outside an authorized verification session', async () => {
    assert.equal(await adminCanSetRuntimeRole(admin), false, 'a temporary SET grant survived a verification session (e.g. a killed process) — run: REVOKE samvardiq_app FROM postgres');
    return 'postgres cannot assume the runtime role';
  });

  await reporter.check('S4 runtime grants: exactly the designed DML per table (no TRUNCATE/REFERENCES/TRIGGER anywhere)', async () => {
    assert.deepEqual(await appPrivilegeMatrix(admin), EXPECTED_APP_PRIVILEGES, 'samvardiq_app privileges per table');
    return 'matrix matches for 16 tables';
  });

  await reporter.check('S5 triggers: the 3 governed triggers exist, enabled, BEFORE ROW, on the right table, calling the right function; all functions SECURITY INVOKER', async () => {
    for (const trigger of EXPECTED_TRIGGERS) {
      const rows = await rowsOf(
        admin,
        `select tg.tgenabled, pg_get_triggerdef(tg.oid) as def from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace ns on ns.oid = c.relnamespace
          where ns.nspname = 'public' and c.relname = $1 and tg.tgname = $2 and not tg.tgisinternal`,
        [trigger.table, trigger.name],
      );
      assert.equal(rows.length, 1, `${trigger.name} exists`);
      assert.equal(rows[0]!.tgenabled, 'O', `${trigger.name} enabled (origin)`);
      const def = String(rows[0]!.def);
      assert.match(def, /BEFORE/);
      assert.match(def, /FOR EACH ROW/);
      assert.ok(def.includes(`EXECUTE FUNCTION ${trigger.fn}()`) || def.includes(`EXECUTE FUNCTION public.${trigger.fn}()`), `${trigger.name} calls ${trigger.fn}`);
    }
    const total = await rowsOf(admin, `select count(*)::int as n from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and not tg.tgisinternal`);
    assert.equal(n(total[0]!.n), 3, 'no unexpected user triggers');
    const fns = await rowsOf(admin, `select proname, prosecdef from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and proname = any($1) order by 1`, [[...OWN_FUNCTIONS]]);
    assert.equal(fns.length, 3);
    assert.ok(fns.every((f) => f.prosecdef === false), 'no Samvardiq function is SECURITY DEFINER');
    return '3/3 triggers enabled; 3/3 functions SECURITY INVOKER';
  });

  await reporter.check('S6 RLS: 12 tenant tables ENABLE+FORCE with policies; 4 platform-global tables RLS-on with only the samvardiq_app-scoped policy; nothing unclassified', async () => {
    const rows = await rowsOf(
      admin,
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
              (select string_agg(p.polname, ',' order by p.polname) from pg_policy p where p.polrelid = c.oid) as policy_names
         from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    const byName = new Map(rows.map((r) => [String(r.relname), r]));
    for (const table of TENANT_TABLES) {
      const row = byName.get(table)!;
      assert.equal(row.rls, true, `${table}: RLS enabled`);
      assert.equal(row.forced, true, `${table}: FORCE RLS`);
      assert.ok(n(row.policies) >= 1, `${table}: has a tenant policy`);
      assert.doesNotMatch(String(row.policy_names), new RegExp(PLATFORM_GLOBAL_POLICY), `${table}: must not carry the platform-global permissive policy`);
    }
    for (const table of PLATFORM_GLOBAL_TABLES) {
      const row = byName.get(table)!;
      assert.equal(row.rls, true, `${table}: RLS enabled (deny-by-default for other roles)`);
      assert.equal(row.policy_names, PLATFORM_GLOBAL_POLICY, `${table}: exactly the samvardiq_app-scoped policy`);
    }
    const policies = await rowsOf(admin, `select tablename, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public' and policyname = $1`, [PLATFORM_GLOBAL_POLICY]);
    assert.equal(policies.length, 4);
    assert.ok(policies.every((p) => p.roles === '{samvardiq_app}'), 'permissive policy targets samvardiq_app only, never PUBLIC/anon/authenticated');
    // Tenant policies must key on the trusted GUCs — never `true`/PUBLIC.
    const tenantPolicies = await rowsOf(admin, `select tablename, qual, with_check from pg_policies where schemaname = 'public' and policyname <> $1`, [PLATFORM_GLOBAL_POLICY]);
    assert.ok(tenantPolicies.every((p) => /current_setting\('app\.current_(org|identity)_id'/.test(`${p.qual ?? ''}${p.with_check ?? ''}`)), 'every tenant policy is keyed on a trusted session GUC');
    return `${TENANT_TABLES.length} tenant + ${PLATFORM_GLOBAL_TABLES.length} platform-global classified; ${tenantPolicies.length} tenant policies`;
  });

  await reporter.check('S7 no credential-bearing column anywhere: only *_reference columns may name a secret/token', async () => {
    const cols = await rowsOf(admin, `select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name ~* '(secret|password|passwd|token|signature|api_?key|credential|private)' order by 1, 2`);
    for (const col of cols) assert.match(String(col.column_name), /_reference$/, `${col.table_name}.${col.column_name} must be a reference, not a value`);
    return `${cols.length} secret-adjacent column(s), all *_reference: ${cols.map((c) => `${c.table_name}.${c.column_name}`).join(', ')}`;
  });

  await reporter.check('E1 exposure: anon/authenticated hold NO privilege (table, column, sequence, function) on any Samvardiq object', async () => {
    for (const role of CLIENT_FACING_ROLES) {
      const tables = await rowsOf(
        admin,
        `select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
          where ns.nspname = 'public' and c.relkind in ('r','v','m','S','f','p')
            and (has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 or (c.relkind <> 'S' and has_any_column_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))
                 or (c.relkind = 'S' and has_sequence_privilege($1, c.oid, 'USAGE,SELECT,UPDATE')))`,
        [role],
      );
      assert.deepEqual(tables, [], `${role}: no privilege on public objects`);
      const fns = await rowsOf(admin, `select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = any($2) and has_function_privilege($1, p.oid, 'EXECUTE')`, [role, [...OWN_FUNCTIONS]]);
      assert.deepEqual(fns, [], `${role}: cannot execute Samvardiq functions`);
    }
    return 'anon=0, authenticated=0 privileges';
  });

  await reporter.check('E2 exposure: the runtime role can reach nothing in Supabase-managed schemas, and no unexpected SECURITY DEFINER exists in public', async () => {
    // Reachable = schema USAGE *and* an object privilege. (Supabase grants PUBLIC SELECT on extensions.pg_stat_statements*,
    // which is unreachable here because samvardiq_app holds no USAGE on the `extensions` schema.)
    const usage = (await rowsOf(admin, `select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' and has_schema_privilege('samvardiq_app', oid, 'USAGE') order by 1`)).map((r) => r.nspname);
    assert.deepEqual(usage, ['public'], 'samvardiq_app has schema USAGE on public only');
    const managed = await rowsOf(
      admin,
      `select ns.nspname, c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname not in ('public','pg_catalog','information_schema') and ns.nspname !~ '^pg_' and c.relkind in ('r','v','m','f','p')
          and has_schema_privilege('samvardiq_app', ns.oid, 'USAGE') and has_table_privilege('samvardiq_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`,
    );
    assert.deepEqual(managed, [], 'samvardiq_app must reach no table outside public');
    const definers = (await rowsOf(admin, `select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.prosecdef order by 1`)).map((r) => r.proname);
    assert.ok(definers.every((name) => name === 'rls_auto_enable'), `only Supabase's own rls_auto_enable may be SECURITY DEFINER (got ${definers.join(',')})`);
    return 'no privileges outside public; definer functions: ' + (definers.join(',') || 'none');
  });

  await reporter.check('E3 exposure (informational): service_role and Data API', async () => {
    const service = await rowsOf(admin, `select count(*)::int as n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and c.relkind = 'r' and has_table_privilege('service_role', c.oid, 'SELECT')`);
    return `service_role (server-only key, bypasses RLS by platform design, never used by Samvardiq — INFRA-W1C Founder decision: retained, not narrowed) can SELECT ${n(service[0]!.n)} public tables; INFRA-W1C confirmed empirically (a live anon-key HTTP request to /rest/v1/goals) that 'public' IS Data-API-exposed — anon/authenticated are fully revoked (E1) and RLS is enabled everywhere (S6) regardless, so this exposure carries no read/write capability`;
  });

  await reporter.check('S9 default ACLs (future objects): anon/authenticated hold no privilege by default on any future public table, sequence or function', async () => {
    const rows = await rowsOf(
      admin,
      `select d.defaclobjtype as objtype, d.defaclacl::text as acl from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname = 'public' and pg_get_userbyid(d.defaclrole) = current_user and d.defaclobjtype in ('r','S','f')`,
    );
    for (const row of rows) {
      const acl = String(row.acl ?? '');
      assert.doesNotMatch(acl, /\banon=/, `default ACL (${row.objtype}): anon must not be named`);
      assert.doesNotMatch(acl, /\bauthenticated=/, `default ACL (${row.objtype}): authenticated must not be named`);
    }
    return `${rows.length} default-ACL rows checked (r/S/f), none name anon/authenticated (a brand-new object still gets an implicit PUBLIC-execute grant for functions specifically — a documented PostgreSQL behavior, not overridable here; closed per-function instead, see S5/E1)`;
  });

  await reporter.check('S10 own functions: search_path pinned (closes the Supabase advisor`s function_search_path_mutable finding)', async () => {
    const rows = await rowsOf(admin, `select proname, proconfig from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and proname = any($1) order by 1`, [[...OWN_FUNCTIONS]]);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const config = (row.proconfig as string[] | null) ?? [];
      assert.ok(config.some((c) => c.startsWith('search_path=')), `${row.proname}: search_path must be pinned`);
    }
    return '3/3 functions have a pinned search_path';
  });
}
