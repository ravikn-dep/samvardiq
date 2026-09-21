/**
 * INFRA-W1B — remote schema/drift audit. The remote database is compared, as
 * a deterministic catalog fingerprint, against a disposable local cluster that
 * was migrated by the very same chain and hardened by the very same step
 * (i.e. the schema every integration test in this repository proved). Any
 * difference is drift. Read-only on the remote side.
 */
import assert from 'node:assert/strict';

import { startLocalSupabaseCluster } from './localSupabaseCluster.js';
import { EXPECTED_JOURNALS } from './structureChecks.js';
import { OWN_FUNCTIONS } from './supabaseHardening.js';
import { Reporter, type AdminPostgres } from './stagingDb.js';

const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

const FINGERPRINT_QUERIES: Record<string, { text: string; params?: unknown[] }> = {
  tables: {
    text: `select c.relname as t, c.relkind as kind, c.relrowsecurity as rls, c.relforcerowsecurity as forced from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = 'public' and c.relkind in ('r','v','m','S','p','f') order by 1`,
  },
  columns: {
    text: `select c.relname as t, a.attname as col, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as def
             from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace ns on ns.oid = c.relnamespace
             left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where ns.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped order by 1, 2`,
  },
  constraints: {
    // contype 'n' (NOT NULL as a catalog constraint) exists only on PostgreSQL 18+; nullability is already compared via `columns`.
    text: `select c.relname as t, con.conname as name, con.contype as type, pg_get_constraintdef(con.oid) as def
             from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = 'public' and con.contype <> 'n' order by 1, 2`,
  },
  indexes: { text: `select tablename as t, indexname as name, indexdef as def from pg_indexes where schemaname = 'public' order by 1, 2` },
  policies: { text: `select tablename as t, policyname as name, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2` },
  triggers: {
    text: `select c.relname as t, tg.tgname as name, tg.tgenabled as enabled, pg_get_triggerdef(tg.oid) as def
             from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace ns on ns.oid = c.relnamespace
            where ns.nspname = 'public' and not tg.tgisinternal order by 1, 2`,
  },
  functions: {
    text: `select p.proname as name, p.prosecdef as definer, p.provolatile as volatility, pg_get_functiondef(p.oid) as def
             from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = any($1) order by 1`,
    params: [[...OWN_FUNCTIONS]],
  },
  appRole: {
    text: `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin, rolinherit from pg_roles where rolname = 'samvardiq_app'`,
  },
  appPrivileges: {
    text: `select c.relname as t, (select string_agg(p, ',' order by p) from unnest($1::text[]) p where has_table_privilege('samvardiq_app', c.oid, p)) as privs
             from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and c.relkind = 'r' order by 1`,
    params: [PRIVS],
  },
  clientRoleExposure: {
    text: `select r as role, (select count(*)::int from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and c.relkind = 'r' and has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) as tables
             from unnest(array['anon','authenticated']) r order by 1`,
  },
};

type Fingerprint = Record<string, unknown[]>;

async function fingerprint(admin: AdminPostgres): Promise<Fingerprint> {
  const out: Fingerprint = {};
  for (const [name, query] of Object.entries(FINGERPRINT_QUERIES)) out[name] = (await admin.pool.query(query.text, query.params)).rows;
  // Journals: hash + created_at per package schema. (Row order = application order.)
  for (const { schema } of Object.values(EXPECTED_JOURNALS)) {
    out[`journal:${schema}`] = (await admin.pool.query(`select hash, created_at::text as created_at from ${schema}.__drizzle_migrations order by created_at`)).rows;
  }
  return out;
}

export async function runDriftAudit(remote: AdminPostgres, reporter: Reporter): Promise<void> {
  await reporter.check('D1 remote schema == reference schema (local cluster, same chain + same hardening): tables, columns, constraints, indexes, policies, triggers, functions, runtime privileges, journals', async () => {
    const local = await startLocalSupabaseCluster(55941, { migrate: true, harden: true });
    try {
      const [expected, actual] = [await fingerprint(local.owner), await fingerprint(remote)];
      const categories = Object.keys(expected);
      const drift: string[] = [];
      for (const category of categories) {
        const same = JSON.stringify(expected[category]) === JSON.stringify(actual[category]);
        if (!same) {
          const want = new Set(expected[category]!.map((r) => JSON.stringify(r)));
          const got = new Set(actual[category]!.map((r) => JSON.stringify(r)));
          const onlyReference = [...want].filter((r) => !got.has(r)).slice(0, 3);
          const onlyRemote = [...got].filter((r) => !want.has(r)).slice(0, 3);
          drift.push(`${category}: onlyReference=${JSON.stringify(onlyReference)} onlyRemote=${JSON.stringify(onlyRemote)}`);
        }
      }
      assert.deepEqual(drift, [], 'schema drift between reference and remote');
      const items = categories.reduce((total, c) => total + expected[c]!.length, 0);
      return `${categories.length} categories / ${items} catalog items identical (reference PostgreSQL vs remote ${String((await remote.pool.query('show server_version')).rows[0]!.server_version)})`;
    } finally {
      await local.stop();
    }
  });
}
