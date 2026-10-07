/**
 * INFRA-W1B — behavioural verification of the migrated schema, run through
 * each package's own real repositories AS the `samvardiq_app` runtime role
 * (never as the RLS-bypassing owner), against SYNTHETIC data only.
 *
 * Safety model:
 *  - Coexists with legitimate persistent staging data (Founder decision D5):
 *    every identifier it creates carries a fresh run prefix `w1b-<8 hex>-`
 *    (syntheticRun.ts); B0 fingerprints every row outside the run and B13
 *    proves those rows are byte-identical afterwards.
 *  - Cleanup (B15, in `finally`) deletes ONLY current-run rows, row by row,
 *    re-checking the prefix in every DELETE; rows the immutability triggers
 *    protect (and rows they reference) are kept, namespaced and reported —
 *    never truncated, never forced. Any other cleanup error fails closed.
 *  - A session advisory lock prevents two verifier runs from overlapping.
 *
 * How the suite acts as the runtime role is the caller's `connect` strategy:
 *  - staging: the owner connection issues `SET ROLE samvardiq_app` on every
 *    pooled session. Because Supabase's `postgres` role is a member of
 *    samvardiq_app WITHOUT the SET option, that needs an explicit, temporary
 *    `GRANT samvardiq_app TO postgres WITH SET TRUE` (revoked in `finally`);
 *    it is only ever done behind the operator's explicit flag.
 *  - local rehearsal: a direct login as samvardiq_app, or SET ROLE as superuser.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { PostgresApprovalRepository, PostgresGoalRepository, PostgresOrganizationRepository, PostgresRecommendationRepository, createPostgresClient as createDataFoundation } from '@samvardiq/data-foundation/dist/postgres/index.js';
import { PostgresIdentityAuditRepository, PostgresIdentityProviderLinkRepository, PostgresIdentityRepository, PostgresMembershipRepository, createPostgresClient as createIdentity } from '@samvardiq/identity-access/dist/postgres/index.js';
import { AuthorizationService } from '@samvardiq/identity-access';
import { PostgresClinicCmsConnectionRepository, PostgresConnectorAuditRepository, createPostgresClient as createCms } from '@samvardiq/clinic-cms-connector/dist/postgres/index.js';
import { PostgresCommunicationChannelRepository, PostgresConversationRepository, PostgresMessageContentRepository, PostgresMessageRepository, PostgresWebhookEventDedupRepository, createPostgresClient as createComms } from '@samvardiq/communication-orchestration/dist/postgres/index.js';
import { computePurgeAfter } from '@samvardiq/communication-orchestration';
import { ACTIVE_KEY_VERSION_ENV, MASTER_KEYS_ENV, MasterKeyRing, ProviderCredentialService, createPostgresClient as createCredentials } from '@samvardiq/platform-credentials';
import { JobQueue, JobRegistry, createPostgresClient as createJobs } from '@samvardiq/platform-jobs';

import { EXPECTED_TABLES, EXPECTED_TRIGGERS, TENANT_TABLES } from './structureChecks.js';
import { acquireVerifierLock, cleanupRun, CONCURRENTLY_WRITTEN, countRunRows, fingerprint, newRunPrefix, SYNTHETIC_PROBES, type CleanupResult } from './syntheticRun.js';
import { Reporter, sanitizeError, type AdminPostgres } from './stagingDb.js';

type Pool = AdminPostgres['pool'];
/** The slice of pg's PoolClient this suite uses (apps/api has no direct pg typings; `Pool['connect']` is overloaded, so it cannot be inferred). */
interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors pg's own QueryResult<any>
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** Produces a package client whose sessions act as samvardiq_app. `create` is that package's own createPostgresClient. */
export type ConnectAsRuntimeRole = <T extends { pool: Pool }>(create: (config: { connectionString: string; max: number; idleTimeoutMillis: number }) => T) => T;

/** Count of pooled sessions whose `SET ROLE samvardiq_app` failed. Any non-zero value fails the suite (B14): a query may already have been pipelined behind the failed switch. */
let roleSwitchFailures = 0;
export const roleSwitchFailureCount = (): number => roleSwitchFailures;

/** Owner connection + `SET ROLE samvardiq_app` on every pooled session (session-level, so it holds under a session pooler). */
export const connectViaSetRole = (ownerConnectionString: string): ConnectAsRuntimeRole => (create) => {
  // idleTimeoutMillis 0: sessions are never recycled mid-run, so no fresh (un-switched) session can appear between checks.
  const client = create({ connectionString: ownerConnectionString, max: 2, idleTimeoutMillis: 0 });
  client.pool.on('connect', (session) => {
    void session.query('SET ROLE samvardiq_app').catch(() => {
      roleSwitchFailures += 1;
      return session.end().catch(() => undefined);
    });
  });
  return client;
};

/** Direct login as samvardiq_app (local rehearsal, where the role has a throwaway password). */
export const connectDirect = (appConnectionString: string): ConnectAsRuntimeRole => (create) => create({ connectionString: appConnectionString, max: 2, idleTimeoutMillis: 0 });

/**
 * Run-scoped synthetic namespace (IDENTITY-SUPABASE-AUTH-STAGING / D5): every
 * identifier this suite creates starts with a fresh `w1b-<8 hex>-` prefix, so
 * cleanup can prove a row belongs to THIS run and never touches legitimate or
 * earlier-run data. Assigned at the start of each run.
 */
let P = '';
let ORG_A = '';
let ORG_B = '';
const now = () => new Date().toISOString();

/** Fails unless the statement is rejected with exactly this SQLSTATE. */
async function expectSqlState(attempt: Promise<unknown>, code: string, label: string): Promise<void> {
  try {
    await attempt;
  } catch (error) {
    assert.equal(sanitizeError(error).code, code, `${label}: SQLSTATE`);
    return;
  }
  assert.fail(`${label}: expected SQLSTATE ${code} but the statement succeeded`);
}

/** One transaction as the runtime role with the given trusted session context (SET LOCAL semantics, like withOrganizationContext). */
async function inTx<T>(pool: Pool, context: { org?: string; identity?: string }, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const who = await client.query('select current_user as u');
    assert.equal(who.rows[0].u, 'samvardiq_app', 'raw transaction must run as the runtime role, never the owner');
    if (context.org !== undefined) await client.query(`select set_config('app.current_org_id', $1, true)`, [context.org]);
    if (context.identity !== undefined) await client.query(`select set_config('app.current_identity_id', $1, true)`, [context.identity]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Rows of `table` created by the current run (its synthetic namespace). */
const runRows = (admin: AdminPostgres, table: string): Promise<number> => countRunRows(admin, table, P);

export async function runBehaviorSuite(admin: AdminPostgres, connect: ConnectAsRuntimeRole, reporter: Reporter): Promise<void> {
  roleSwitchFailures = 0;
  P = newRunPrefix();
  ORG_A = `${P}org-A`;
  ORG_B = `${P}org-B`;
  // ---- precondition: exclusive run, every table probed, fingerprint of everything outside this run ---------------
  let releaseLock: (() => Promise<void>) | undefined;
  let baseline: Record<string, string> = {};
  await reporter.check('B0 precondition: exclusive verifier run; every table has a synthetic probe; rows outside this run are fingerprinted (legitimate data may exist and must survive unchanged)', async () => {
    releaseLock = await acquireVerifierLock(admin);
    assert.deepEqual(Object.keys(SYNTHETIC_PROBES).sort(), [...EXPECTED_TABLES].sort(), 'every table has a synthetic probe');
    for (const table of EXPECTED_TABLES) assert.equal(await runRows(admin, table), 0, `${table}: the fresh run namespace is unused`);
    baseline = await fingerprint(admin, EXPECTED_TABLES, P);
    const existing = Object.values(baseline).reduce((n, f) => n + Number(f.split(':')[0]), 0);
    return `run ${P}; lock held; ${existing} pre-existing rows fingerprinted across ${Object.keys(baseline).length} tables`;
  });
  if (!releaseLock) return;

  const df = connect((config) => createDataFoundation(config));
  const idn = connect((config) => createIdentity(config));
  const cms = connect((config) => createCms(config));
  const comms = connect((config) => createComms(config));
  const cred = connect((config) => createCredentials(config));
  const jobs = connect((config) => createJobs(config));

  try {
    const organizations = new PostgresOrganizationRepository(df.db);
    const goals = new PostgresGoalRepository(df.db);
    const recommendations = new PostgresRecommendationRepository(df.db);
    const approvals = new PostgresApprovalRepository(df.db);
    const identities = new PostgresIdentityRepository(idn.db);
    const links = new PostgresIdentityProviderLinkRepository(idn.db);
    const memberships = new PostgresMembershipRepository(idn.db);
    const audit = new PostgresIdentityAuditRepository(idn.db);
    const authz = new AuthorizationService(identities, links, memberships);
    const connections = new PostgresClinicCmsConnectionRepository(cms.db);
    const evidence = new PostgresConnectorAuditRepository(cms.db);
    const channels = new PostgresCommunicationChannelRepository(comms.db);
    const conversations = new PostgresConversationRepository(comms.db);
    const messages = new PostgresMessageRepository(comms.db);
    const content = new PostgresMessageContentRepository(comms.db);
    const dedup = new PostgresWebhookEventDedupRepository(comms.db);
    const pools: Record<string, Pool> = {
      'data-foundation': df.pool, 'identity-access': idn.pool, 'clinic-cms-connector': cms.pool, 'communication-orchestration': comms.pool, 'platform-credentials': cred.pool, 'platform-jobs': jobs.pool,
    };

    let roleOk = false;
    await reporter.check(`B1 every runtime session really is samvardiq_app (not the owner), on all ${Object.keys(pools).length} package pools`, async () => {
      for (const [name, pool] of Object.entries(pools)) {
        // Several sessions per pool, concurrently, so a pooled session that missed the role switch cannot hide.
        const who = await Promise.all([1, 2, 3].map(() => pool.query('select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass')));
        for (const result of who) assert.deepEqual({ ...result.rows[0] }, { u: 'samvardiq_app', bypass: false }, `${name}: pooled session role`);
      }
      roleOk = true;
      return `${Object.keys(pools).length} pools x 3 concurrent sessions = samvardiq_app, NOBYPASSRLS`;
    });
    if (!roleOk) return; // never continue as a role that bypasses RLS

    // ---- data-foundation: persistence + tenant isolation ----------------------------------------------------------
    await organizations.create({ organizationId: ORG_A, organizationType: 'clinic', name: 'w1b Test Clinic Alpha' });
    await organizations.create({ organizationId: ORG_B, organizationType: 'clinic', name: 'w1b Test Clinic Beta' });
    await goals.create({ goalId: `${P}goal-A`, organizationId: ORG_A, title: 'w1b synthetic goal A', description: 'synthetic' });
    await goals.create({ goalId: `${P}goal-B`, organizationId: ORG_B, title: 'w1b synthetic goal B', description: 'synthetic' });
    const recommendation = await recommendations.save({
      recommendationId: `${P}rec-A`, organizationId: ORG_A, goalId: `${P}goal-A`, owningExecutive: 'CMO', originatingSkill: 'healthcare-local-growth',
      title: 'w1b synthetic recommendation', status: 'Ready for Approval', approvalRequirement: 2, risk: 'low',
      evidenceReferences: [{ source: 'google_business_profile', description: 'synthetic' }], confidence: 80, createdAt: now(),
    });

    await reporter.check('B2 cross-organization isolation (data-foundation): A cannot read or write B, by repository and by raw SQL', async () => {
      assert.equal((await goals.get(ORG_A, `${P}goal-B`)), undefined, 'repository: A cannot read B`s goal');
      assert.equal((await goals.get(ORG_B, `${P}goal-B`))?.goalId, `${P}goal-B`, 'B reads its own');
      const seenByA = await inTx(df.pool, { org: ORG_A }, async (c) => (await c.query('select distinct organization_id from goals')).rows.map((r: { organization_id: string }) => r.organization_id));
      assert.deepEqual(seenByA, [ORG_A], 'raw unscoped SELECT under A sees only A');
      const orgsSeenByA = await inTx(df.pool, { org: ORG_A }, async (c) => (await c.query('select organization_id from organizations')).rows.length);
      assert.equal(orgsSeenByA, 1);
      await expectSqlState(
        inTx(df.pool, { org: ORG_A }, (c) => c.query(`insert into goals (organization_id, goal_id, title, description, status) values ('${ORG_B}', '${P}sneaky', 'x', 'y', 'active')`)),
        '42501', 'A inserting a row owned by B',
      );
      const updatedB = await inTx(df.pool, { org: ORG_A }, async (c) => (await c.query(`update goals set title = 'hijack' where organization_id = '${ORG_B}'`)).rowCount);
      assert.equal(updatedB, 0, 'A updates zero of B`s rows');
      return 'A sees 1/1 own rows, 0 of B; cross-org INSERT = 42501; cross-org UPDATE = 0 rows';
    });

    // ---- approvals: atomicity, concurrency, immutability ----------------------------------------------------------
    const baseRequest = (id: string) => ({
      approvalRequestId: id, organizationId: ORG_A, goalId: `${P}goal-A`, recommendationId: recommendation.recommendationId, requestedBy: 'CMO',
      requiredApprovalLevel: 2 as const, risk: 'low' as const, reason: 'synthetic', status: 'PENDING' as const, createdAt: now(),
    });
    const decisionRecord = (requestId: string, suffix: string, decision: 'APPROVED' | 'REJECTED', requestedAt: string) =>
      Object.freeze({
        approvalRecordId: `${P}audit-${suffix}`, approvalRequestId: requestId, organizationId: ORG_A, goalId: `${P}goal-A`, recommendationId: recommendation.recommendationId,
        requiredApprovalLevel: 2 as const, decision, approverId: `${P}approver-${suffix}`, approverRole: 'founder' as const, rationale: undefined,
        requestedAt, decidedAt: now(), previousState: 'PENDING' as const, resultingState: decision,
      });

    await reporter.check('B3 approval atomicity: a valid decision commits request transition + record together; an induced mid-transaction failure rolls back BOTH', async () => {
      await approvals.saveRequest(baseRequest(`${P}req-K`));
      const requestK = (await approvals.getRequest(ORG_A, `${P}req-K`))!;
      await approvals.recordDecision({ ...requestK, status: 'APPROVED', decidedAt: now() }, decisionRecord(`${P}req-K`, 'K', 'APPROVED', requestK.createdAt));
      assert.equal((await approvals.getRequest(ORG_A, `${P}req-K`))?.status, 'APPROVED');
      assert.equal((await approvals.listRecords(ORG_A, `${P}req-K`)).length, 1);

      await approvals.saveRequest(baseRequest(`${P}req-L`));
      await expectSqlState(
        inTx(df.pool, { org: ORG_A }, async (c) => {
          await c.query(`update approval_requests set status = 'APPROVED', decided_at = now() where organization_id = $1 and approval_request_id = '${P}req-L' and status = 'PENDING'`, [ORG_A]);
          await c.query(
            `insert into approval_records (organization_id, approval_record_id, approval_request_id, goal_id, recommendation_id, required_approval_level, decision, approver_id, approver_role, requested_at, decided_at, previous_state, resulting_state)
             values ($1, '${P}audit-L', '${P}req-L', '${P}goal-A', $2, 2, 'NOT_A_REAL_DECISION', '${P}approver', 'founder', now(), now(), 'PENDING', 'APPROVED')`,
            [ORG_A, recommendation.recommendationId],
          );
        }),
        '23514', 'invalid decision violates the CHECK constraint',
      );
      assert.equal((await approvals.getRequest(ORG_A, `${P}req-L`))?.status, 'PENDING', 'the UPDATE rolled back with the failed INSERT');
      assert.equal((await approvals.listRecords(ORG_A, `${P}req-L`)).length, 0, 'no partial record survives');
      return 'commit = request APPROVED + 1 record; failure = request still PENDING + 0 records';
    });

    await reporter.check('B4 approval concurrency: two simultaneous decisions on one request produce exactly one terminal record and one deterministic rejection', async () => {
      await approvals.saveRequest(baseRequest(`${P}req-M`));
      const requestM = (await approvals.getRequest(ORG_A, `${P}req-M`))!;
      const results = await Promise.allSettled([
        approvals.recordDecision({ ...requestM, status: 'APPROVED', decidedAt: now() }, decisionRecord(`${P}req-M`, 'Ma', 'APPROVED', requestM.createdAt)),
        approvals.recordDecision({ ...requestM, status: 'REJECTED', decidedAt: now() }, decisionRecord(`${P}req-M`, 'Mb', 'REJECTED', requestM.createdAt)),
      ]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0]!.reason as Error).constructor.name, 'ApprovalRequestConcurrencyError');
      assert.equal((await approvals.listRecords(ORG_A, `${P}req-M`)).length, 1, 'exactly one terminal ApprovalRecord');
      assert.notEqual((await approvals.getRequest(ORG_A, `${P}req-M`))?.status, 'PENDING');
      return '1 fulfilled, 1 ApprovalRequestConcurrencyError, 1 record';
    });

    await reporter.check('B5 approval-record immutability: runtime role denied UPDATE/DELETE (42501); the trigger blocks even the owner (P0001); goal-consistency trigger rejects a mismatched request', async () => {
      const before = await runRows(admin, 'approval_records');
      await expectSqlState(inTx(df.pool, { org: ORG_A }, (c) => c.query(`update approval_records set decision = 'REJECTED' where organization_id = $1`, [ORG_A])), '42501', 'app UPDATE');
      await expectSqlState(inTx(df.pool, { org: ORG_A }, (c) => c.query(`delete from approval_records where organization_id = $1`, [ORG_A])), '42501', 'app DELETE');
      await expectSqlState(admin.pool.query(`update approval_records set decision = 'REJECTED' where organization_id = $1`, [ORG_A]), 'P0001', 'owner UPDATE');
      await expectSqlState(admin.pool.query(`delete from approval_records where organization_id = $1`, [ORG_A]), 'P0001', 'owner DELETE');
      assert.equal(await runRows(admin, 'approval_records'), before, 'no record changed');
      await expectSqlState(
        inTx(df.pool, { org: ORG_A }, (c) => c.query(`insert into approval_requests (organization_id, approval_request_id, goal_id, recommendation_id, requested_by, required_approval_level, risk, reason, status) values ($1, '${P}req-bad', '${P}goal-OTHER', $2, 'CMO', 2, 'low', 'synthetic', 'PENDING')`, [ORG_A, recommendation.recommendationId])),
        'P0001', 'goal consistency',
      );
      const crossOrgRecords = await inTx(df.pool, { org: ORG_B }, async (c) => (await c.query('select 1 from approval_records')).rows.length);
      assert.equal(crossOrgRecords, 0, 'org B cannot see org A`s approval audit trail');
      return `${before} records unchanged after 4 mutation attempts; trigger fires for the owner`;
    });

    // ---- identity + membership authorization ------------------------------------------------------------------------
    const principal = (subject: string, provider = `${P}synthetic`) => ({ provider, providerSubject: subject, verifiedAt: now() });
    await reporter.check('B6 identity provisioning as the runtime role (F1 fix proof) and membership authorization semantics', async () => {
      for (const [id, type] of [[`${P}id-owner-a`, 'human'], [`${P}id-member-a`, 'human'], [`${P}id-viewer-a`, 'human'], [`${P}id-owner-b`, 'human'], [`${P}id-svc-a`, 'service']] as const) {
        await identities.create({ identityId: id, principalType: type, displayName: id });
        await links.create({ identityId: id, provider: type === 'service' ? `${P}whatsapp-channel` : `${P}synthetic`, providerSubject: `sub-${id}` });
      }
      await memberships.create({ organizationId: ORG_A, identityId: `${P}id-owner-a`, role: 'OWNER', status: 'ACTIVE' });
      await memberships.create({ organizationId: ORG_A, identityId: `${P}id-member-a`, role: 'MEMBER', status: 'ACTIVE' });
      await memberships.create({ organizationId: ORG_A, identityId: `${P}id-viewer-a`, role: 'VIEWER', status: 'ACTIVE' });
      await memberships.create({ organizationId: ORG_B, identityId: `${P}id-owner-b`, role: 'OWNER', status: 'ACTIVE' });
      await memberships.create({ organizationId: ORG_A, identityId: `${P}id-svc-a`, role: 'MEMBER', status: 'ACTIVE', approverRole: 'founder' });
      await memberships.create({ organizationId: ORG_B, identityId: `${P}id-member-a`, role: 'VIEWER', status: 'ACTIVE' });

      assert.deepEqual(await authz.listEligibleOrganizations(principal(`sub-${P}id-owner-a`)), [{ organizationId: ORG_A, role: 'OWNER' }]);
      assert.deepEqual(
        (await authz.listEligibleOrganizations(principal(`sub-${P}id-member-a`))).sort((x, y) => x.organizationId.localeCompare(y.organizationId)),
        [{ organizationId: ORG_A, role: 'MEMBER' }, { organizationId: ORG_B, role: 'VIEWER' }],
      );
      assert.deepEqual(await authz.listEligibleOrganizations(principal('sub-unlinked')), []);

      const owner = await authz.resolveTrustedContext({ principal: principal(`sub-${P}id-owner-a`), requestedOrganizationId: ORG_A });
      assert.equal(owner.role, 'OWNER');
      assert.equal(owner.principalType, 'human');
      await assert.rejects(authz.resolveTrustedContext({ principal: principal(`sub-${P}id-owner-b`), requestedOrganizationId: ORG_A }), (e: Error) => e.constructor.name === 'MembershipNotFoundError');
      const service = await authz.resolveTrustedContext({ principal: principal(`sub-${P}id-svc-a`, `${P}whatsapp-channel`), requestedOrganizationId: ORG_A });
      assert.equal(service.principalType, 'service');
      assert.equal(service.approverRole, undefined, 'a service principal never carries approval authority, even with a misconfigured approverRole row');

      await memberships.updateStatus(ORG_A, `${P}id-viewer-a`, 'SUSPENDED');
      await assert.rejects(authz.resolveTrustedContext({ principal: principal(`sub-${P}id-viewer-a`), requestedOrganizationId: ORG_A }), (e: Error) => e.constructor.name === 'MembershipNotActiveError');
      assert.deepEqual(await authz.listEligibleOrganizations(principal(`sub-${P}id-viewer-a`)), [], 'a suspended membership grants no eligibility');
      return 'OWNER/MEMBER/VIEWER/service resolved as designed; cross-org, unlinked and suspended all denied';
    });

    await reporter.check('B7 membership RLS: org-scoped writes, org-or-self reads, identity context is read-only, spoofed cross-org insert rejected', async () => {
      const seenByA = await inTx(idn.pool, { org: ORG_A }, async (c) => (await c.query('select distinct organization_id from organization_memberships')).rows.map((r: { organization_id: string }) => r.organization_id));
      assert.deepEqual(seenByA, [ORG_A], 'org context: only that organization`s memberships');
      const selfRows = await inTx(idn.pool, { identity: `${P}id-member-a` }, async (c) => (await c.query('select organization_id, identity_id from organization_memberships order by 1')).rows);
      assert.deepEqual(selfRows.map((r: { organization_id: string }) => r.organization_id), [ORG_A, ORG_B]);
      assert.ok(selfRows.every((r: { identity_id: string }) => r.identity_id === `${P}id-member-a`), 'identity context reveals only the identity`s own rows');
      const updated = await inTx(idn.pool, { identity: `${P}id-member-a` }, async (c) => (await c.query(`update organization_memberships set role = 'OWNER' where identity_id = '${P}id-member-a'`)).rowCount);
      assert.equal(updated, 0, 'identity-scoped context grants zero write capability');
      await expectSqlState(
        inTx(idn.pool, { org: ORG_A }, (c) => c.query(`insert into organization_memberships (organization_id, identity_id, role, status) values ('${ORG_B}', '${P}id-owner-a', 'OWNER', 'ACTIVE')`)),
        '42501', 'spoofed cross-org membership insert',
      );
      return 'org=1 org visible; self=2 own rows; identity-context UPDATE = 0 rows; spoof = 42501';
    });

    await reporter.check('B8 identity-audit: append + org/global isolation; runtime role denied UPDATE/DELETE (42501); trigger blocks even the owner (P0001); spoofed insert rejected', async () => {
      const eventA = await audit.append({ organizationId: ORG_A, actor: { principalType: 'human', identityId: `${P}id-owner-a` }, eventType: 'MEMBERSHIP_STATUS_CHANGED', targetType: 'MEMBERSHIP', targetId: `${ORG_A}::${P}id-viewer-a`, outcome: 'SUCCESS' });
      await audit.append({ organizationId: ORG_B, actor: { principalType: 'human', identityId: `${P}id-owner-b` }, eventType: 'MEMBERSHIP_STATUS_CHANGED', targetType: 'MEMBERSHIP', targetId: `${ORG_B}::${P}id-owner-b`, outcome: 'SUCCESS' });
      await audit.append({ actor: { principalType: 'system' }, eventType: 'IDENTITY_CREATED', targetType: 'IDENTITY', targetId: `${P}id-owner-a`, outcome: 'SUCCESS' });
      const forA = await audit.listByOrganization(ORG_A);
      assert.equal(forA.length, 1);
      assert.equal(forA[0]!.eventId, eventA.eventId);
      assert.equal((await audit.listByOrganization(ORG_B)).length, 1);
      assert.equal((await audit.listGlobal()).filter((e) => e.targetId.startsWith(P)).length, 1, 'this run`s global event is visible only through the global path');
      // Tamper probes are scoped to this run's organization: refusal is still proven, but no statement can ever reach legitimate rows.
      await expectSqlState(inTx(idn.pool, { org: ORG_A }, (c) => c.query(`update identity_audit_events set outcome = 'FAILURE' where organization_id = '${ORG_A}'`)), '42501', 'app UPDATE');
      await expectSqlState(inTx(idn.pool, { org: ORG_A }, (c) => c.query(`delete from identity_audit_events where organization_id = '${ORG_A}'`)), '42501', 'app DELETE');
      await expectSqlState(admin.pool.query(`update identity_audit_events set outcome = 'FAILURE' where organization_id = '${ORG_A}'`), 'P0001', 'owner UPDATE');
      await expectSqlState(admin.pool.query(`delete from identity_audit_events where organization_id = '${ORG_A}'`), 'P0001', 'owner DELETE');
      await expectSqlState(
        inTx(idn.pool, { org: ORG_A }, (c) => c.query(`insert into identity_audit_events (event_id, organization_id, actor_principal_type, actor_identity_id, event_type, target_type, target_id, outcome) values ('${P}evt-spoof', '${ORG_B}', 'human', '${P}id-owner-a', 'MEMBERSHIP_STATUS_CHANGED', 'MEMBERSHIP', '${ORG_B}::x', 'SUCCESS')`)),
        '42501', 'spoofed cross-org audit insert',
      );
      assert.equal(await runRows(admin, 'identity_audit_events'), 3, 'no audit event was altered or removed');
      return '3 events intact after 5 tamper attempts';
    });

    // ---- Clinic CMS connector -----------------------------------------------------------------------------------
    await reporter.check('B9 CMS connector persistence + isolation: per-org connection, reference-only secret, evidence with human and service actors, actor CHECK, cross-org and no-context denial', async () => {
      const base = { baseUrl: 'https://cms.invalid', keyId: `${P}key`, approvedScopes: ['health:read' as const], timezone: 'Asia/Kolkata', enabled: true, createdAt: now(), updatedAt: now() };
      await connections.create({ ...base, connectionId: `${P}conn-A`, organizationId: ORG_A, secretReference: 'env:W1B_NONEXISTENT_SECRET_A' });
      await connections.create({ ...base, connectionId: `${P}conn-B`, organizationId: ORG_B, secretReference: 'env:W1B_NONEXISTENT_SECRET_B' });
      const forA = await connections.getEnabledForOrganization(ORG_A);
      assert.equal(forA?.connectionId, `${P}conn-A`);
      assert.equal(forA?.secretReference, 'env:W1B_NONEXISTENT_SECRET_A', 'only a reference is stored');
      assert.equal((await connections.getEnabledForOrganization(ORG_B))?.connectionId, `${P}conn-B`);

      const ev = (id: string, org: string, actor?: { id: string; type: 'human' | 'service' }) => ({
        evidenceId: id, organizationId: org, connectionId: org === ORG_A ? `${P}conn-A` : `${P}conn-B`, connectorType: 'clinic-cms' as const, operation: 'listConsultants', correlationId: `${P}corr-${id}`,
        outcome: 'SUCCESS' as const, retryCount: 0, actorIdentityId: actor?.id, actorPrincipalType: actor?.type, occurredAt: now(),
      });
      await evidence.record(ev(`${P}ev-human`, ORG_A, { id: `${P}id-owner-a`, type: 'human' }));
      await evidence.record(ev(`${P}ev-service`, ORG_A, { id: `${P}id-svc-a`, type: 'service' }));
      await evidence.record(ev(`${P}ev-b`, ORG_B));
      const rowsA = await inTx(cms.pool, { org: ORG_A }, async (c) => (await c.query('select evidence_id, actor_identity_id, actor_principal_type from clinic_cms_connector_evidence order by evidence_id')).rows);
      assert.deepEqual(rowsA.map((r: { evidence_id: string }) => r.evidence_id), [`${P}ev-human`, `${P}ev-service`]);
      assert.deepEqual(rowsA.map((r: { actor_principal_type: string }) => r.actor_principal_type), ['human', 'service']);
      await expectSqlState(
        inTx(cms.pool, { org: ORG_A }, (c) => c.query(`insert into clinic_cms_connector_evidence (organization_id, evidence_id, connection_id, connector_type, operation, correlation_id, outcome, retry_count, actor_principal_type) values ($1, '${P}ev-bad', '${P}conn-A', 'clinic-cms', 'x', '${P}c', 'SUCCESS', 0, 'robot')`, [ORG_A])),
        '23514', 'actor_principal_type CHECK',
      );
      await expectSqlState(
        inTx(cms.pool, { org: ORG_A }, (c) => c.query(`insert into clinic_cms_connections (organization_id, connection_id, base_url, key_id, secret_reference, approved_scopes, timezone, enabled) values ('${ORG_B}', '${P}conn-x', 'https://cms.invalid', 'k', 'env:X', '[]'::jsonb, 'Asia/Kolkata', true)`)),
        '42501', 'cross-org connection insert',
      );
      return 'A resolves only its connection; evidence keeps actor human+service; robot actor = 23514; cross-org = 42501';
    });

    // ---- communication orchestration + W2C -------------------------------------------------------------------------
    await reporter.check('B10 communication persistence + isolation: platform-global channel lookup, duplicate rejection, org-scoped conversations/messages/raw content, dedup, purge', async () => {
      const channel = (id: string, org: string, ext: string) => ({
        channelId: id, organizationId: org, provider: 'meta_whatsapp_cloud_api' as const, externalChannelId: ext, serviceIdentityId: `${P}id-svc-a`, serviceProviderSubject: id,
        accessTokenReference: 'env:W1B_NONEXISTENT_TOKEN', displayPhoneNumber: '+000000000000', timezone: 'Asia/Kolkata', enabled: true, createdAt: now(), updatedAt: now(),
      });
      await channels.create(channel(`${P}chan-A`, ORG_A, `${P}phone-A`));
      assert.equal((await channels.getEnabledByExternalChannelId(`${P}phone-A`))?.organizationId, ORG_A, 'platform-global lookup by external id works with no org context');
      await expectSqlState(channels.create(channel(`${P}chan-dup`, ORG_B, `${P}phone-A`)), '23505', 'duplicate external_channel_id');

      const conversation = (id: string, org: string, contact: string, state: 'AI_ACTIVE' | 'HUMAN_HANDOFF_REQUESTED') => ({
        conversationId: id, organizationId: org, channelId: `${P}chan-A`, externalContactId: contact, state, preferredLanguage: 'en-IN' as const, bookingState: 'NEW' as const, createdAt: now(), updatedAt: now(),
      });
      await conversations.create(conversation(`${P}conv-A`, ORG_A, `${P}contact-A`, 'AI_ACTIVE'));
      await conversations.create(conversation(`${P}conv-B`, ORG_B, `${P}contact-B`, 'AI_ACTIVE'));
      assert.equal((await conversations.getByExternalContact(ORG_A, `${P}chan-A`, `${P}contact-A`))?.conversationId, `${P}conv-A`);
      assert.equal(await conversations.getByExternalContact(ORG_A, `${P}chan-A`, `${P}contact-B`), null, 'A cannot resolve B`s contact');
      const updated = await conversations.update({ ...conversation(`${P}conv-A`, ORG_A, `${P}contact-A`, 'AI_ACTIVE'), bookingState: 'BOOKED', activeAppointmentId: `${P}apt-1`, updatedAt: now() });
      assert.equal(updated.bookingState, 'BOOKED');
      assert.equal((await conversations.getById(ORG_A, `${P}conv-A`))?.activeAppointmentId, `${P}apt-1`);

      await messages.record({ messageId: `${P}msg-A`, organizationId: ORG_A, conversationId: `${P}conv-A`, direction: 'INBOUND', messageType: 'text', createdAt: now() });
      await messages.record({ messageId: `${P}msg-B`, organizationId: ORG_B, conversationId: `${P}conv-B`, direction: 'INBOUND', messageType: 'text', createdAt: now() });
      assert.deepEqual((await messages.listByConversation(ORG_A, `${P}conv-A`)).map((m) => m.messageId), [`${P}msg-A`]);
      assert.deepEqual(await messages.listByConversation(ORG_A, `${P}conv-B`), [], 'A cannot list B`s conversation');

      await content.record({ organizationId: ORG_A, messageId: `${P}msg-A`, rawText: 'w1b synthetic text A', purgeAfter: computePurgeAfter() });
      await content.record({ organizationId: ORG_B, messageId: `${P}msg-B`, rawText: 'w1b synthetic text B', purgeAfter: computePurgeAfter() });
      await content.record({ organizationId: ORG_A, messageId: `${P}msg-old`, rawText: 'w1b expired', purgeAfter: new Date(Date.now() - 1000).toISOString() });
      assert.equal((await content.get(ORG_A, `${P}msg-A`))?.rawText, 'w1b synthetic text A');
      assert.equal(await content.get(ORG_A, `${P}msg-B`), null, 'A can never read B`s raw content, even by guessing the id');
      assert.equal(await content.purgeExpired(ORG_A), 1, 'only the expired row is purged');
      assert.equal(await content.get(ORG_A, `${P}msg-old`), null);
      assert.notEqual(await content.get(ORG_A, `${P}msg-A`), null);

      assert.equal(await dedup.reserve('meta_whatsapp_cloud_api', `${P}wamid-1`), true);
      assert.equal(await dedup.reserve('meta_whatsapp_cloud_api', `${P}wamid-1`), false, 'duplicate provider event rejected');
      await expectSqlState(comms.pool.query(`insert into webhook_event_dedup (provider, external_event_id) values ('meta_whatsapp_cloud_api', '${P}wamid-1')`), '23505', 'dedup unique constraint');
      await expectSqlState(inTx(comms.pool, { org: ORG_A }, (c) => c.query(`insert into conversations (organization_id, conversation_id, channel_id, external_contact_id, state, preferred_language, booking_state) values ('${ORG_B}', '${P}conv-x', '${P}chan-A', '${P}cx', 'AI_ACTIVE', 'en-IN', 'NEW')`)), '42501', 'cross-org conversation insert');
      return 'channel/dedup dup = 23505; A isolated from B for conversations, messages, raw content; expired content purged';
    });

    await reporter.check('B11 W2C human-handoff read path: RLS-scoped, HUMAN_HANDOFF_REQUESTED only, real timestamptz ordering + cursor pagination', async () => {
      const handoff = (id: string, org: string, contact: string, at: string) => ({
        conversationId: id, organizationId: org, channelId: `${P}chan-A`, externalContactId: contact, state: 'HUMAN_HANDOFF_REQUESTED' as const, preferredLanguage: 'en-IN' as const, bookingState: 'NEW' as const,
        handoffTrigger: 'CMS_UNRECOVERABLE_FAILURE' as const, createdAt: at, updatedAt: at,
      });
      await conversations.create(handoff(`${P}conv-A-h1`, ORG_A, `${P}contact-h1`, '2026-01-01T00:00:01.000Z'));
      await conversations.create(handoff(`${P}conv-A-h2`, ORG_A, `${P}contact-h2`, '2026-01-01T00:00:02.000Z'));
      await conversations.create(handoff(`${P}conv-B-h1`, ORG_B, `${P}contact-hb`, '2026-01-01T00:00:03.000Z'));
      const page1 = await conversations.listHumanHandoffs(ORG_A, { limit: 1 });
      assert.deepEqual(page1.items.map((c) => c.conversationId), [`${P}conv-A-h2`], 'newest first');
      assert.ok(page1.nextCursor, 'more pages exist');
      const page2 = await conversations.listHumanHandoffs(ORG_A, { limit: 1, cursor: page1.nextCursor });
      assert.deepEqual(page2.items.map((c) => c.conversationId), [`${P}conv-A-h1`]);
      assert.equal(page2.nextCursor, undefined);
      assert.deepEqual((await conversations.listHumanHandoffs(ORG_B, { limit: 20 })).items.map((c) => c.conversationId), [`${P}conv-B-h1`], 'B sees only its own handoff');
      const noContext = await comms.pool.query(`select 1 from conversations where state = 'HUMAN_HANDOFF_REQUESTED'`);
      assert.equal(noContext.rows.length, 0, 'no context: the handoff rows are invisible');
      // CLINIC-W2D as the runtime role: atomic claim, still listed with its owner, audited; org B cannot reach A's handoff.
      assert.equal((await conversations.claimHumanHandoff(ORG_B, `${P}conv-A-h1`, `${P}staff-B`)).kind, 'NOT_FOUND', 'cross-org claim');
      assert.equal((await conversations.claimHumanHandoff(ORG_A, `${P}conv-A-h1`, `${P}staff-A`)).kind, 'CLAIMED');
      assert.equal((await conversations.claimHumanHandoff(ORG_A, `${P}conv-A-h1`, `${P}staff-A2`)).kind, 'CONFLICT');
      const claimedRow = (await conversations.listHumanHandoffs(ORG_A, { limit: 20 })).items.find((c) => c.conversationId === `${P}conv-A-h1`);
      assert.deepEqual([claimedRow?.state, claimedRow?.handoffOwnerIdentityId], ['HUMAN_ACTIVE', `${P}staff-A`]);
      assert.deepEqual((await conversations.listHandoffEvents(ORG_A, `${P}conv-A-h1`)).map((e) => [e.eventType, e.actorIdentityId]), [['CLAIMED', `${P}staff-A`]]);
      return 'A: 2 handoffs in 2 pages (AI_ACTIVE conversation excluded); B: 1; no-context: 0; W2D claim: one owner, audited, cross-org NOT_FOUND';
    });

    // ---- PLATFORM-CREDENTIALS-W1 (ARCH-020) -----------------------------------------------------------------------------
    await reporter.check('B16 ARCH-020 credential store as the runtime role: OWNER connects, the org service principal resolves, only ciphertext at rest, humans/other orgs refused, disconnect deletes the ciphertext', async () => {
      // Ephemeral in-process key ring: generated for this run only, never printed or persisted; B15 truncates every row it wrapped.
      const keyRing = MasterKeyRing.fromEnv({ [MASTER_KEYS_ENV]: `1:${randomBytes(32).toString('base64')}`, [ACTIVE_KEY_VERSION_ENV]: '1' });
      const credentials = new ProviderCredentialService(cred.db, keyRing);
      const ownerA = await authz.resolveTrustedContext({ principal: principal(`sub-${P}id-owner-a`), requestedOrganizationId: ORG_A });
      const ownerB = await authz.resolveTrustedContext({ principal: principal(`sub-${P}id-owner-b`), requestedOrganizationId: ORG_B });
      const serviceA = await authz.resolveTrustedContext({ principal: principal(`sub-${P}id-svc-a`, `${P}whatsapp-channel`), requestedOrganizationId: ORG_A });
      const secretA = Buffer.from(`${P}synthetic-secret-${randomBytes(8).toString('hex')}`);
      const secretB = Buffer.from(`${P}synthetic-secret-${randomBytes(8).toString('hex')}`);
      const input = (secret: Buffer) => ({ provider: 'w1b_synthetic', externalAccountId: `${P}account`, grantedScopes: ['w1b.read'], credentialType: 'w1b_token', secret });
      const kept = await credentials.connect(ownerA, input(secretA));
      const dropped = await credentials.connect(ownerB, input(secretB));

      assert.equal(await credentials.useCredential(serviceA, kept.connectionId, 'w1b_token', async (s) => s.equals(secretA)), true, 'service principal resolves its own organization`s credential');
      const refused = async (attempt: Promise<unknown>, name: string) => assert.rejects(attempt, (e: Error) => e.constructor.name === name);
      await refused(credentials.useCredential(ownerA, kept.connectionId, 'w1b_token', async () => true), 'CredentialAccessDeniedError');
      await refused(credentials.useCredential(serviceA, dropped.connectionId, 'w1b_token', async () => true), 'CredentialUnavailableError');
      await refused(credentials.connect(serviceA, input(secretA)), 'CredentialAccessDeniedError');

      const atRest = (await admin.pool.query('select ciphertext from public.external_provider_credentials')).rows as { ciphertext: Buffer }[];
      assert.ok(atRest.length === 2 && atRest.every((r) => !r.ciphertext.includes(secretA) && !r.ciphertext.includes(secretB)), 'only ciphertext at rest');
      const crossOrg = await inTx(cred.pool, { org: ORG_A }, async (c) => (await c.query(`select 1 from external_provider_credentials where organization_id = $1`, [ORG_B])).rows.length);
      assert.equal(crossOrg, 0, 'A cannot see B`s credential rows');
      await expectSqlState(inTx(cred.pool, { org: ORG_A }, (c) => c.query(`update external_provider_credentials set ciphertext = '\\x00' where organization_id = '${ORG_A}'`)), '42501', 'runtime ciphertext rewrite');
      await expectSqlState(admin.pool.query(`delete from public.external_provider_credential_events where organization_id = '${ORG_A}'`), 'P0001', 'owner audit DELETE');

      const disconnected = await credentials.disconnect(ownerB, dropped.connectionId);
      assert.equal(disconnected.remoteRevocation, 'NOT_ATTEMPTED');
      assert.equal(Number((await admin.pool.query('select count(*)::int as n from public.external_provider_credentials where organization_id = $1', [ORG_B])).rows[0].n), 0, 'disconnect deleted the ciphertext');
      return 'connect/use/refuse/disconnect as samvardiq_app; ciphertext-only at rest; cross-org 0 rows; ciphertext rewrite = 42501; audit owner DELETE = P0001';
    });

    // ---- PLATFORM-JOBS-W1 (ARCH-021) ----------------------------------------------------------------------------------
    await reporter.check('B17 ARCH-021 job queue as the runtime role: idempotent enqueue, one claim under contention, fenced completion, identifiers-only payload, immutable job identity', async () => {
      // A per-run job type, claimed by type only: the suite can never claim (and complete) a real or earlier-run job.
      const jobType = `w1b.run_${P.slice(4, 12)}`;
      const registry = new JobRegistry().register({ type: jobType, scope: 'organization', payload: { period: 'date' }, maxAttempts: 2, handle: async () => undefined });
      const queue = new JobQueue(jobs.db, registry);
      const input = { type: jobType, organizationId: ORG_A, idempotencyKey: `${P}job-1`, payload: { period: '2026-01-01' } };
      const first = await queue.enqueue(input);
      const again = await Promise.all([1, 2, 3].map(() => queue.enqueue(input)));
      assert.ok(first.created && again.every((r) => !r.created && r.jobId === first.jobId), 'one logical job');
      await assert.rejects(queue.enqueue({ ...input, idempotencyKey: `${P}job-2`, payload: { period: '2026-01-01', note: 'free text' } }), (e: Error) => e.constructor.name === 'InvalidJobError');
      const claims = await Promise.all([1, 2, 3, 4].map((i) => queue.claim(`${P}worker-${i}`, 30_000, [jobType])));
      const won = claims.filter((c) => c !== null);
      assert.equal(won.length, 1, 'exactly one claim');
      assert.equal(await queue.complete(first.jobId, randomUUID()), false, 'a foreign lease cannot complete');
      assert.equal(await queue.complete(first.jobId, won[0]!.leaseId), true);
      // Privilege probes are scoped to this run's own row; they are refused (42501) before touching anything.
      await expectSqlState(jobs.pool.query(`update platform_jobs set payload = '{}'::jsonb where job_id = $1`, [first.jobId]), '42501', 'runtime payload rewrite');
      await expectSqlState(jobs.pool.query(`update platform_jobs set organization_id = '${ORG_B}' where job_id = $1`, [first.jobId]), '42501', 'runtime organization rewrite');
      await expectSqlState(jobs.pool.query(`delete from platform_jobs where job_id = $1`, [first.jobId]), '42501', 'runtime delete');
      const state = (await admin.pool.query(`select status, attempts from public.platform_jobs where job_id = $1`, [first.jobId])).rows[0];
      assert.deepEqual({ ...state }, { status: 'SUCCEEDED', attempts: 1 });
      return 'enqueue x4 = 1 job; free-text payload rejected; 4 contenders = 1 claim; foreign lease refused; payload/org rewrite and DELETE = 42501';
    });

    // ---- missing organization context ------------------------------------------------------------------------------
    await reporter.check(`B12 missing-context fail-closed: all ${TENANT_TABLES.length} populated tenant tables return zero rows with no context, and writes are rejected`, async () => {
      const allPools = Object.values(pools);
      for (const table of TENANT_TABLES) {
        assert.ok((await runRows(admin, table)) > 0, `${table}: populated by this run (else this proof is vacuous)`);
        // By design (package test R), identity_audit_events with no context exposes ONLY its global (organization_id IS NULL) events —
        // never an organization-scoped one. Every other tenant table exposes nothing.
        const expectedVisible = table === 'identity_audit_events' ? Number(((await admin.pool.query(`select count(*)::int as n from public.${table} where organization_id is null`)).rows[0] as { n: number }).n) : 0;
        const visible = await Promise.all(allPools.map(async (pool) => Number(((await pool.query(`select count(*)::int as n from public.${table}`)).rows[0] as { n: number }).n)));
        assert.deepEqual(visible, allPools.map(() => expectedVisible), `${table}: no session context must expose nothing tenant-scoped`);
      }
      const orgScopedAudit = await idn.pool.query(`select count(*)::int as n from identity_audit_events where organization_id is not null`);
      assert.equal(Number((orgScopedAudit.rows[0] as { n: number }).n), 0, 'no organization-scoped audit event is visible without context');
      const spoof = await df.pool.query(`select 1 from goals where organization_id = '${ORG_A}'`);
      assert.equal(spoof.rows.length, 0, 'a WHERE clause claiming an organization does not substitute for session context');
      const writes: [Pool, string][] = [
        [df.pool, `insert into goals (organization_id, goal_id, title, description, status) values ('${ORG_A}', '${P}noctx', 'x', 'y', 'active')`],
        [idn.pool, `insert into organization_memberships (organization_id, identity_id, role, status) values ('${ORG_A}', '${P}id-owner-a', 'OWNER', 'ACTIVE')`],
        [idn.pool, `insert into identity_audit_events (event_id, organization_id, actor_principal_type, event_type, target_type, target_id, outcome) values ('${P}evt-noctx', '${ORG_A}', 'system', 'MEMBERSHIP_STATUS_CHANGED', 'MEMBERSHIP', 'x', 'SUCCESS')`],
        [cms.pool, `insert into clinic_cms_connections (organization_id, connection_id, base_url, key_id, secret_reference, approved_scopes, timezone, enabled) values ('${ORG_A}', '${P}noctx', 'https://cms.invalid', 'k', 'env:X', '[]'::jsonb, 'Asia/Kolkata', true)`],
        [comms.pool, `insert into conversations (organization_id, conversation_id, channel_id, external_contact_id, state, preferred_language, booking_state) values ('${ORG_A}', '${P}noctx', '${P}chan-A', '${P}c', 'AI_ACTIVE', 'en-IN', 'NEW')`],
        [cred.pool, `insert into external_provider_connections (organization_id, connection_id, provider, status, granted_scopes, connected_by_identity_id) values ('${ORG_A}', '${P}noctx', 'w1b_synthetic', 'ACTIVE', '[]'::jsonb, '${P}id-owner-a')`],
      ];
      for (const [pool, text] of writes) await expectSqlState(pool.query(text), '42501', 'no-context write');
      return `${TENANT_TABLES.length} tables x ${allPools.length} pools = 0 tenant rows visible (identity_audit_events: global events only, by design); ${writes.length} representative no-context writes = 42501`;
    });

    await reporter.check('B13 isolation: every row outside this run (legitimate staging data, earlier-run remnants) is byte-identical to the B0 fingerprint', async () => {
      assert.deepEqual(await fingerprint(admin, EXPECTED_TABLES, P), baseline, 'rows outside the run changed');
      return `${Object.keys(baseline).length} tables unchanged outside run ${P}`;
    });

    await reporter.check('B14 runtime-role integrity: no pooled session ever failed to switch to samvardiq_app', async () => {
      assert.equal(roleSwitchFailures, 0, 'a session that failed SET ROLE may have run queries as the RLS-bypassing owner');
      return '0 failed role switches';
    });
  } finally {
    // ---- cleanup (always) ------------------------------------------------------------------------------------------
    await Promise.allSettled([df, idn, cms, comms, cred, jobs].map((client) => (client.pool as Pool).end()));
    let cleanup: CleanupResult | undefined;
    await reporter.check('B15 cleanup: only this run`s rows are deleted (row by row, prefix re-checked); immutable audit rows and the rows they reference are kept and namespaced; everything outside the run is unchanged; governed triggers still enabled', async () => {
      try {
        cleanup = await cleanupRun(admin, EXPECTED_TABLES, P);
        // The LIVE scheduler (staging runs it) may enumerate this run's synthetic channel organization and enqueue a
        // retention job for it while cleanup runs. Such rows carry this run's namespace; let in-flight ticks settle and
        // sweep them too (bounded). Only this run's namespace is ever touched.
        // Always settle once (an in-flight tick may have enumerated the channel just before cleanup committed), then
        // re-sweep while any appear, bounded.
        for (const table of CONCURRENTLY_WRITTEN) {
          for (let attempt = 0; attempt === 0 || (attempt < 5 && (await runRows(admin, table)) > 0); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            cleanup.deleted += (await cleanupRun(admin, [table], P)).deleted;
          }
        }
        assert.deepEqual(await fingerprint(admin, EXPECTED_TABLES, P), baseline, 'cleanup changed rows outside the run');
        const kept = { ...cleanup.immutable, ...cleanup.referenced };
        for (const table of Object.keys(kept)) assert.equal(await runRows(admin, table), (cleanup.immutable[table] ?? 0) + (cleanup.referenced[table] ?? 0), `${table}: retained count`);
        for (const table of EXPECTED_TABLES.filter((t) => !(t in kept))) assert.equal(await runRows(admin, table), 0, `${table}: no run rows left`);
        const triggers = await admin.pool.query(`select count(*)::int as n from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and not tg.tgisinternal and tg.tgenabled = 'O'`);
        assert.equal(Number((triggers.rows[0] as { n: number }).n), EXPECTED_TRIGGERS.length);
        const fmt = (r: Record<string, number>) => Object.entries(r).map(([t, n]) => `${t}=${n}`).join(',') || 'none';
        return `deleted ${cleanup.deleted} run rows; kept (immutable) ${fmt(cleanup.immutable)}; kept (referenced by retained) ${fmt(cleanup.referenced)}; outside-run fingerprint unchanged; ${EXPECTED_TRIGGERS.length} triggers enabled`;
      } finally {
        await releaseLock?.();
      }
    });
  }
}
