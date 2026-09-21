/**
 * INFRA-W1B — the founder-authorized, temporary role-membership lifecycle
 * that lets the staging behavioural suite run as the real `samvardiq_app`
 * runtime role.
 *
 * Authorized (and ONLY this): `GRANT samvardiq_app TO postgres WITH SET TRUE`,
 * on samvardiq-staging, for the duration of one verification session. Never a
 * password, LOGIN, privilege change, BYPASSRLS or SUPERUSER — and it must not
 * survive the session.
 *
 * Supabase provisions `postgres` with a pre-existing membership in
 * `samvardiq_app` (granted by `supabase_admin`, ADMIN OPTION only, no SET).
 * Because the temporary grant is issued by `postgres` itself, it is a separate
 * pg_auth_members edge (grantor = postgres), so `REVOKE samvardiq_app FROM
 * postgres` removes exactly that edge and leaves the platform's own edge
 * untouched. Cleanup is verified against a snapshot taken BEFORE the grant,
 * runs in `finally`, and any failure to prove restoration is a security
 * failure, not a test failure.
 */
import assert from 'node:assert/strict';

import { EXPECTED_APP_PRIVILEGES, adminCanSetRuntimeRole as canSet, appPrivilegeMatrix } from './structureChecks.js';
import { Reporter, sanitizeError, type AdminPostgres } from './stagingDb.js';

export interface RoleEdge {
  grantor: string;
  admin: boolean;
  inherit: boolean;
  set: boolean;
}

const ATTRS_SQL = `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin from pg_roles where rolname = 'samvardiq_app'`;

/** Every membership edge in `samvardiq_app` held by the current (admin) role. */
async function edgesOf(admin: AdminPostgres): Promise<RoleEdge[]> {
  const { rows } = await admin.pool.query(
    `select pg_get_userbyid(m.grantor) as grantor, m.admin_option as admin, m.inherit_option as inherit, m.set_option as set
       from pg_auth_members m where m.roleid = 'samvardiq_app'::regrole and m.member = (select oid from pg_roles where rolname = current_user) order by 1, 2, 3, 4`,
  );
  return rows as RoleEdge[];
}

export interface RoleGrantOutcome {
  /** True when the temporary membership could not be proven fully removed and the role state restored. */
  securityFailure: boolean;
}

/** Runs `work` while the admin role holds the temporary SET capability, then always revokes it and proves the restoration. */
export async function withTemporarySetRole(admin: AdminPostgres, reporter: Reporter, work: () => Promise<void>): Promise<RoleGrantOutcome> {
  let pre: { attrs: Record<string, boolean>; edges: RoleEdge[]; matrix: Record<string, string> } | undefined;

  await reporter.check('P1 pre-grant: sanitized identity, samvardiq_app hardened attributes, recorded role-membership state, runtime grant matrix', async () => {
    const identity = (await admin.pool.query(`select current_database() as db, current_user as role, split_part(version(), ' ', 2) as pg`)).rows[0] as { db: string; role: string; pg: string };
    assert.equal(identity.role, 'postgres', 'the authorized grant names the admin role `postgres`');
    const attrs = (await admin.pool.query(ATTRS_SQL)).rows[0] as Record<string, boolean>;
    for (const key of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolbypassrls', 'rolreplication'] as const) assert.equal(attrs[key], false, `samvardiq_app ${key}`);
    const edges = await edgesOf(admin);
    assert.equal(await canSet(admin), false, 'no SET capability before the grant');
    const matrix = await appPrivilegeMatrix(admin);
    assert.deepEqual(matrix, EXPECTED_APP_PRIVILEGES);
    pre = { attrs, edges, matrix };
    return `db=${identity.db} role=${identity.role} pg=${identity.pg}; NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS/NOREPLICATION confirmed (LOGIN=${attrs.rolcanlogin} is the migration design, passwordless); pre-existing membership edges=${JSON.stringify(edges)}`;
  });
  if (!pre) return { securityFailure: false }; // nothing granted, nothing to revoke
  const before = pre;

  try {
    await admin.pool.query('GRANT samvardiq_app TO postgres WITH SET TRUE');

    await reporter.check('P2 SET ROLE samvardiq_app really makes the session run as samvardiq_app (not the owner, not bypassing RLS)', async () => {
      const session = await admin.pool.connect();
      try {
        await session.query('SET ROLE samvardiq_app');
        const who = (await session.query(`select current_user as cu, session_user as su, (select rolbypassrls from pg_roles where rolname = current_user) as bypass, (select rolsuper from pg_roles where rolname = current_user) as sup`)).rows[0] as Record<string, unknown>;
        assert.deepEqual({ ...who }, { cu: 'samvardiq_app', su: 'postgres', bypass: false, sup: false });
        return 'current_user=samvardiq_app, session_user=postgres, rolbypassrls=false, rolsuper=false';
      } finally {
        await session.query('RESET ROLE').catch(() => undefined);
        session.release();
      }
    });

    await work();
  } catch (error) {
    // Never let an aborted run skip revocation, and never let it vanish: it is recorded as a failed check.
    const sanitized = sanitizeError(error);
    reporter.results.push({ id: 'W0 verification aborted before completion', ok: false, detail: `${sanitized.code ? `[${sanitized.code}] ` : ''}${sanitized.message}` });
  }
  // Reached whether or not the GRANT, P2 or the suite failed — the grant may have taken effect at any point after it was issued.
  return cleanupAndProve(admin, reporter, before);
}

async function cleanupAndProve(admin: AdminPostgres, reporter: Reporter, before: { attrs: Record<string, boolean>; edges: RoleEdge[]; matrix: Record<string, string> }): Promise<RoleGrantOutcome> {
  let securityFailure = false;
  try {
    const now = await edgesOf(admin);
    if (JSON.stringify(now) !== JSON.stringify(before.edges)) {
      // The authorized revocation: removes only grants made by `postgres` — i.e. the temporary edge.
      if (now.length > before.edges.length) await admin.pool.query('REVOKE samvardiq_app FROM postgres');
      // Same edge count with different options: the grant modified an existing edge; restore by dropping only the SET option.
      else await admin.pool.query('REVOKE SET OPTION FOR samvardiq_app FROM postgres');
    }
  } catch {
    securityFailure = true; // fall through to the independent verification below, which reports the true state
  }

  const verify = async (id: string, fn: () => Promise<string>) => {
    await reporter.check(id, fn);
    if (reporter.results[reporter.results.length - 1]!.ok === false) securityFailure = true;
  };

  await verify('R1 temporary membership revoked: no SET capability, membership edges identical to the pre-grant record', async () => {
    assert.equal(await canSet(admin), false, 'postgres must not be able to SET ROLE samvardiq_app');
    assert.deepEqual(await edgesOf(admin), before.edges, 'membership edges must equal the recorded pre-grant state');
    return `SET capability absent; remaining edges are the platform's own: ${JSON.stringify(before.edges)}`;
  });
  await verify('R2 samvardiq_app itself gained nothing: no SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION, LOGIN unchanged', async () => {
    const attrs = (await admin.pool.query(ATTRS_SQL)).rows[0] as Record<string, boolean>;
    assert.deepEqual(attrs, before.attrs);
    return 'all role attributes identical to the pre-grant record';
  });
  await verify('R3 runtime grant matrix unchanged and equals the designed matrix', async () => {
    const matrix = await appPrivilegeMatrix(admin);
    assert.deepEqual(matrix, before.matrix);
    assert.deepEqual(matrix, EXPECTED_APP_PRIVILEGES);
    return 'privilege matrix identical for 16 tables';
  });
  return { securityFailure };
}
