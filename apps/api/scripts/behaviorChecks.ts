/**
 * INFRA-W1B — behavioural verification of the migrated schema, run through
 * each package's own real repositories AS the `samvardiq_app` runtime role
 * (never as the RLS-bypassing owner), against SYNTHETIC data only.
 *
 * Safety model:
 *  - Refuses to write anything unless every Samvardiq table is already empty
 *    (so every row that later exists is provably this suite's, and cleanup
 *    can never destroy real data).
 *  - Every synthetic identifier is prefixed `w1b-`; a check proves no other
 *    value exists before cleanup.
 *  - Cleanup is `TRUNCATE` by the owner (a deliberate, documented exception:
 *    the immutability triggers correctly forbid DELETE on approval_records and
 *    identity_audit_events, even for the owner) and runs in `finally`.
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

import { PostgresApprovalRepository, PostgresGoalRepository, PostgresOrganizationRepository, PostgresRecommendationRepository, createPostgresClient as createDataFoundation } from '@samvardiq/data-foundation/dist/postgres/index.js';
import { PostgresIdentityAuditRepository, PostgresIdentityProviderLinkRepository, PostgresIdentityRepository, PostgresMembershipRepository, createPostgresClient as createIdentity } from '@samvardiq/identity-access/dist/postgres/index.js';
import { AuthorizationService } from '@samvardiq/identity-access';
import { PostgresClinicCmsConnectionRepository, PostgresConnectorAuditRepository, createPostgresClient as createCms } from '@samvardiq/clinic-cms-connector/dist/postgres/index.js';
import { PostgresCommunicationChannelRepository, PostgresConversationRepository, PostgresMessageContentRepository, PostgresMessageRepository, PostgresWebhookEventDedupRepository, createPostgresClient as createComms } from '@samvardiq/communication-orchestration/dist/postgres/index.js';
import { computePurgeAfter } from '@samvardiq/communication-orchestration';

import { EXPECTED_TABLES, TENANT_TABLES } from './structureChecks.js';
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

const ORG_A = 'w1b-org-A';
const ORG_B = 'w1b-org-B';
const SYNTHETIC_PREFIX = 'w1b-';
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

const countRows = async (pool: Pool, table: string): Promise<number> => Number(((await pool.query(`select count(*)::int as n from public.${table}`)).rows[0] as { n: number }).n);

/** Every persisted row must carry a synthetic `w1b-` identifier. Global (NULL-organization) audit events are probed by their target id. */
async function assertOnlySynthetic(admin: AdminPostgres): Promise<void> {
  const probes: [string, string][] = [
    ['organizations', 'organization_id'], ['goals', 'organization_id'], ['recommendations', 'organization_id'], ['approval_requests', 'organization_id'], ['approval_records', 'organization_id'],
    ['organization_memberships', 'organization_id'], ['identity_audit_events', 'coalesce(organization_id, target_id)'], ['clinic_cms_connections', 'organization_id'], ['clinic_cms_connector_evidence', 'organization_id'],
    ['conversations', 'organization_id'], ['communication_messages', 'organization_id'], ['communication_message_content', 'organization_id'], ['communication_channels', 'organization_id'],
    ['identities', 'identity_id'], ['identity_provider_links', 'identity_id'], ['webhook_event_dedup', 'external_event_id'],
  ];
  assert.equal(probes.length, EXPECTED_TABLES.length);
  for (const [table, expression] of probes) {
    const foreign = await admin.pool.query(`select count(*)::int as n from public.${table} where ${expression} is not null and ${expression} not like $1`, [`${SYNTHETIC_PREFIX}%`]);
    assert.equal(Number((foreign.rows[0] as { n: number }).n), 0, `${table}: only synthetic values`);
  }
}

export async function runBehaviorSuite(admin: AdminPostgres, connect: ConnectAsRuntimeRole, reporter: Reporter): Promise<void> {
  roleSwitchFailures = 0;
  // ---- precondition: provably empty, else write nothing and clean nothing ----------------------------------------
  let empty = false;
  await reporter.check('B0 precondition: every Samvardiq table is empty (so all data below is provably synthetic)', async () => {
    const populated: string[] = [];
    for (const table of EXPECTED_TABLES) if ((await countRows(admin.pool, table)) > 0) populated.push(table);
    assert.deepEqual(populated, [], 'refusing to write: tables already hold data');
    empty = true;
    return '16/16 tables empty';
  });
  if (!empty) return;

  const df = connect((config) => createDataFoundation(config));
  const idn = connect((config) => createIdentity(config));
  const cms = connect((config) => createCms(config));
  const comms = connect((config) => createComms(config));

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
    const pools: Record<string, Pool> = { 'data-foundation': df.pool, 'identity-access': idn.pool, 'clinic-cms-connector': cms.pool, 'communication-orchestration': comms.pool };

    let roleOk = false;
    await reporter.check('B1 every runtime session really is samvardiq_app (not the owner), on all four package pools', async () => {
      for (const [name, pool] of Object.entries(pools)) {
        // Several sessions per pool, concurrently, so a pooled session that missed the role switch cannot hide.
        const who = await Promise.all([1, 2, 3].map(() => pool.query('select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass')));
        for (const result of who) assert.deepEqual({ ...result.rows[0] }, { u: 'samvardiq_app', bypass: false }, `${name}: pooled session role`);
      }
      roleOk = true;
      return '4 pools x 3 concurrent sessions = samvardiq_app, NOBYPASSRLS';
    });
    if (!roleOk) return; // never continue as a role that bypasses RLS

    // ---- data-foundation: persistence + tenant isolation ----------------------------------------------------------
    await organizations.create({ organizationId: ORG_A, organizationType: 'clinic', name: 'w1b Test Clinic Alpha' });
    await organizations.create({ organizationId: ORG_B, organizationType: 'clinic', name: 'w1b Test Clinic Beta' });
    await goals.create({ goalId: 'w1b-goal-A', organizationId: ORG_A, title: 'w1b synthetic goal A', description: 'synthetic' });
    await goals.create({ goalId: 'w1b-goal-B', organizationId: ORG_B, title: 'w1b synthetic goal B', description: 'synthetic' });
    const recommendation = await recommendations.save({
      recommendationId: 'w1b-rec-A', organizationId: ORG_A, goalId: 'w1b-goal-A', owningExecutive: 'CMO', originatingSkill: 'healthcare-local-growth',
      title: 'w1b synthetic recommendation', status: 'Ready for Approval', approvalRequirement: 2, risk: 'low',
      evidenceReferences: [{ source: 'google_business_profile', description: 'synthetic' }], confidence: 80, createdAt: now(),
    });

    await reporter.check('B2 cross-organization isolation (data-foundation): A cannot read or write B, by repository and by raw SQL', async () => {
      assert.equal((await goals.get(ORG_A, 'w1b-goal-B')), undefined, 'repository: A cannot read B`s goal');
      assert.equal((await goals.get(ORG_B, 'w1b-goal-B'))?.goalId, 'w1b-goal-B', 'B reads its own');
      const seenByA = await inTx(df.pool, { org: ORG_A }, async (c) => (await c.query('select distinct organization_id from goals')).rows.map((r: { organization_id: string }) => r.organization_id));
      assert.deepEqual(seenByA, [ORG_A], 'raw unscoped SELECT under A sees only A');
      const orgsSeenByA = await inTx(df.pool, { org: ORG_A }, async (c) => (await c.query('select organization_id from organizations')).rows.length);
      assert.equal(orgsSeenByA, 1);
      await expectSqlState(
        inTx(df.pool, { org: ORG_A }, (c) => c.query(`insert into goals (organization_id, goal_id, title, description, status) values ('${ORG_B}', 'w1b-sneaky', 'x', 'y', 'active')`)),
        '42501', 'A inserting a row owned by B',
      );
      const updatedB = await inTx(df.pool, { org: ORG_A }, async (c) => (await c.query(`update goals set title = 'hijack' where organization_id = '${ORG_B}'`)).rowCount);
      assert.equal(updatedB, 0, 'A updates zero of B`s rows');
      return 'A sees 1/1 own rows, 0 of B; cross-org INSERT = 42501; cross-org UPDATE = 0 rows';
    });

    // ---- approvals: atomicity, concurrency, immutability ----------------------------------------------------------
    const baseRequest = (id: string) => ({
      approvalRequestId: id, organizationId: ORG_A, goalId: 'w1b-goal-A', recommendationId: recommendation.recommendationId, requestedBy: 'CMO',
      requiredApprovalLevel: 2 as const, risk: 'low' as const, reason: 'synthetic', status: 'PENDING' as const, createdAt: now(),
    });
    const decisionRecord = (requestId: string, suffix: string, decision: 'APPROVED' | 'REJECTED', requestedAt: string) =>
      Object.freeze({
        approvalRecordId: `w1b-audit-${suffix}`, approvalRequestId: requestId, organizationId: ORG_A, goalId: 'w1b-goal-A', recommendationId: recommendation.recommendationId,
        requiredApprovalLevel: 2 as const, decision, approverId: `w1b-approver-${suffix}`, approverRole: 'founder' as const, rationale: undefined,
        requestedAt, decidedAt: now(), previousState: 'PENDING' as const, resultingState: decision,
      });

    await reporter.check('B3 approval atomicity: a valid decision commits request transition + record together; an induced mid-transaction failure rolls back BOTH', async () => {
      await approvals.saveRequest(baseRequest('w1b-req-K'));
      const requestK = (await approvals.getRequest(ORG_A, 'w1b-req-K'))!;
      await approvals.recordDecision({ ...requestK, status: 'APPROVED', decidedAt: now() }, decisionRecord('w1b-req-K', 'K', 'APPROVED', requestK.createdAt));
      assert.equal((await approvals.getRequest(ORG_A, 'w1b-req-K'))?.status, 'APPROVED');
      assert.equal((await approvals.listRecords(ORG_A, 'w1b-req-K')).length, 1);

      await approvals.saveRequest(baseRequest('w1b-req-L'));
      await expectSqlState(
        inTx(df.pool, { org: ORG_A }, async (c) => {
          await c.query(`update approval_requests set status = 'APPROVED', decided_at = now() where organization_id = $1 and approval_request_id = 'w1b-req-L' and status = 'PENDING'`, [ORG_A]);
          await c.query(
            `insert into approval_records (organization_id, approval_record_id, approval_request_id, goal_id, recommendation_id, required_approval_level, decision, approver_id, approver_role, requested_at, decided_at, previous_state, resulting_state)
             values ($1, 'w1b-audit-L', 'w1b-req-L', 'w1b-goal-A', $2, 2, 'NOT_A_REAL_DECISION', 'w1b-approver', 'founder', now(), now(), 'PENDING', 'APPROVED')`,
            [ORG_A, recommendation.recommendationId],
          );
        }),
        '23514', 'invalid decision violates the CHECK constraint',
      );
      assert.equal((await approvals.getRequest(ORG_A, 'w1b-req-L'))?.status, 'PENDING', 'the UPDATE rolled back with the failed INSERT');
      assert.equal((await approvals.listRecords(ORG_A, 'w1b-req-L')).length, 0, 'no partial record survives');
      return 'commit = request APPROVED + 1 record; failure = request still PENDING + 0 records';
    });

    await reporter.check('B4 approval concurrency: two simultaneous decisions on one request produce exactly one terminal record and one deterministic rejection', async () => {
      await approvals.saveRequest(baseRequest('w1b-req-M'));
      const requestM = (await approvals.getRequest(ORG_A, 'w1b-req-M'))!;
      const results = await Promise.allSettled([
        approvals.recordDecision({ ...requestM, status: 'APPROVED', decidedAt: now() }, decisionRecord('w1b-req-M', 'Ma', 'APPROVED', requestM.createdAt)),
        approvals.recordDecision({ ...requestM, status: 'REJECTED', decidedAt: now() }, decisionRecord('w1b-req-M', 'Mb', 'REJECTED', requestM.createdAt)),
      ]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0]!.reason as Error).constructor.name, 'ApprovalRequestConcurrencyError');
      assert.equal((await approvals.listRecords(ORG_A, 'w1b-req-M')).length, 1, 'exactly one terminal ApprovalRecord');
      assert.notEqual((await approvals.getRequest(ORG_A, 'w1b-req-M'))?.status, 'PENDING');
      return '1 fulfilled, 1 ApprovalRequestConcurrencyError, 1 record';
    });

    await reporter.check('B5 approval-record immutability: runtime role denied UPDATE/DELETE (42501); the trigger blocks even the owner (P0001); goal-consistency trigger rejects a mismatched request', async () => {
      const before = await countRows(admin.pool, 'approval_records');
      await expectSqlState(inTx(df.pool, { org: ORG_A }, (c) => c.query(`update approval_records set decision = 'REJECTED' where organization_id = $1`, [ORG_A])), '42501', 'app UPDATE');
      await expectSqlState(inTx(df.pool, { org: ORG_A }, (c) => c.query(`delete from approval_records where organization_id = $1`, [ORG_A])), '42501', 'app DELETE');
      await expectSqlState(admin.pool.query(`update approval_records set decision = 'REJECTED' where organization_id = $1`, [ORG_A]), 'P0001', 'owner UPDATE');
      await expectSqlState(admin.pool.query(`delete from approval_records where organization_id = $1`, [ORG_A]), 'P0001', 'owner DELETE');
      assert.equal(await countRows(admin.pool, 'approval_records'), before, 'no record changed');
      await expectSqlState(
        inTx(df.pool, { org: ORG_A }, (c) => c.query(`insert into approval_requests (organization_id, approval_request_id, goal_id, recommendation_id, requested_by, required_approval_level, risk, reason, status) values ($1, 'w1b-req-bad', 'w1b-goal-OTHER', $2, 'CMO', 2, 'low', 'synthetic', 'PENDING')`, [ORG_A, recommendation.recommendationId])),
        'P0001', 'goal consistency',
      );
      const crossOrgRecords = await inTx(df.pool, { org: ORG_B }, async (c) => (await c.query('select 1 from approval_records')).rows.length);
      assert.equal(crossOrgRecords, 0, 'org B cannot see org A`s approval audit trail');
      return `${before} records unchanged after 4 mutation attempts; trigger fires for the owner`;
    });

    // ---- identity + membership authorization ------------------------------------------------------------------------
    const principal = (subject: string, provider = 'w1b-synthetic') => ({ provider, providerSubject: subject, verifiedAt: now() });
    await reporter.check('B6 identity provisioning as the runtime role (F1 fix proof) and membership authorization semantics', async () => {
      for (const [id, type] of [['w1b-id-owner-a', 'human'], ['w1b-id-member-a', 'human'], ['w1b-id-viewer-a', 'human'], ['w1b-id-owner-b', 'human'], ['w1b-id-svc-a', 'service']] as const) {
        await identities.create({ identityId: id, principalType: type, displayName: id });
        await links.create({ identityId: id, provider: type === 'service' ? 'w1b-whatsapp-channel' : 'w1b-synthetic', providerSubject: `sub-${id}` });
      }
      await memberships.create({ organizationId: ORG_A, identityId: 'w1b-id-owner-a', role: 'OWNER', status: 'ACTIVE' });
      await memberships.create({ organizationId: ORG_A, identityId: 'w1b-id-member-a', role: 'MEMBER', status: 'ACTIVE' });
      await memberships.create({ organizationId: ORG_A, identityId: 'w1b-id-viewer-a', role: 'VIEWER', status: 'ACTIVE' });
      await memberships.create({ organizationId: ORG_B, identityId: 'w1b-id-owner-b', role: 'OWNER', status: 'ACTIVE' });
      await memberships.create({ organizationId: ORG_A, identityId: 'w1b-id-svc-a', role: 'MEMBER', status: 'ACTIVE', approverRole: 'founder' });
      await memberships.create({ organizationId: ORG_B, identityId: 'w1b-id-member-a', role: 'VIEWER', status: 'ACTIVE' });

      assert.deepEqual(await authz.listEligibleOrganizations(principal('sub-w1b-id-owner-a')), [{ organizationId: ORG_A, role: 'OWNER' }]);
      assert.deepEqual(
        (await authz.listEligibleOrganizations(principal('sub-w1b-id-member-a'))).sort((x, y) => x.organizationId.localeCompare(y.organizationId)),
        [{ organizationId: ORG_A, role: 'MEMBER' }, { organizationId: ORG_B, role: 'VIEWER' }],
      );
      assert.deepEqual(await authz.listEligibleOrganizations(principal('sub-unlinked')), []);

      const owner = await authz.resolveTrustedContext({ principal: principal('sub-w1b-id-owner-a'), requestedOrganizationId: ORG_A });
      assert.equal(owner.role, 'OWNER');
      assert.equal(owner.principalType, 'human');
      await assert.rejects(authz.resolveTrustedContext({ principal: principal('sub-w1b-id-owner-b'), requestedOrganizationId: ORG_A }), (e: Error) => e.constructor.name === 'MembershipNotFoundError');
      const service = await authz.resolveTrustedContext({ principal: principal('sub-w1b-id-svc-a', 'w1b-whatsapp-channel'), requestedOrganizationId: ORG_A });
      assert.equal(service.principalType, 'service');
      assert.equal(service.approverRole, undefined, 'a service principal never carries approval authority, even with a misconfigured approverRole row');

      await memberships.updateStatus(ORG_A, 'w1b-id-viewer-a', 'SUSPENDED');
      await assert.rejects(authz.resolveTrustedContext({ principal: principal('sub-w1b-id-viewer-a'), requestedOrganizationId: ORG_A }), (e: Error) => e.constructor.name === 'MembershipNotActiveError');
      assert.deepEqual(await authz.listEligibleOrganizations(principal('sub-w1b-id-viewer-a')), [], 'a suspended membership grants no eligibility');
      return 'OWNER/MEMBER/VIEWER/service resolved as designed; cross-org, unlinked and suspended all denied';
    });

    await reporter.check('B7 membership RLS: org-scoped writes, org-or-self reads, identity context is read-only, spoofed cross-org insert rejected', async () => {
      const seenByA = await inTx(idn.pool, { org: ORG_A }, async (c) => (await c.query('select distinct organization_id from organization_memberships')).rows.map((r: { organization_id: string }) => r.organization_id));
      assert.deepEqual(seenByA, [ORG_A], 'org context: only that organization`s memberships');
      const selfRows = await inTx(idn.pool, { identity: 'w1b-id-member-a' }, async (c) => (await c.query('select organization_id, identity_id from organization_memberships order by 1')).rows);
      assert.deepEqual(selfRows.map((r: { organization_id: string }) => r.organization_id), [ORG_A, ORG_B]);
      assert.ok(selfRows.every((r: { identity_id: string }) => r.identity_id === 'w1b-id-member-a'), 'identity context reveals only the identity`s own rows');
      const updated = await inTx(idn.pool, { identity: 'w1b-id-member-a' }, async (c) => (await c.query(`update organization_memberships set role = 'OWNER' where identity_id = 'w1b-id-member-a'`)).rowCount);
      assert.equal(updated, 0, 'identity-scoped context grants zero write capability');
      await expectSqlState(
        inTx(idn.pool, { org: ORG_A }, (c) => c.query(`insert into organization_memberships (organization_id, identity_id, role, status) values ('${ORG_B}', 'w1b-id-owner-a', 'OWNER', 'ACTIVE')`)),
        '42501', 'spoofed cross-org membership insert',
      );
      return 'org=1 org visible; self=2 own rows; identity-context UPDATE = 0 rows; spoof = 42501';
    });

    await reporter.check('B8 identity-audit: append + org/global isolation; runtime role denied UPDATE/DELETE (42501); trigger blocks even the owner (P0001); spoofed insert rejected', async () => {
      const eventA = await audit.append({ organizationId: ORG_A, actor: { principalType: 'human', identityId: 'w1b-id-owner-a' }, eventType: 'MEMBERSHIP_STATUS_CHANGED', targetType: 'MEMBERSHIP', targetId: `${ORG_A}::w1b-id-viewer-a`, outcome: 'SUCCESS' });
      await audit.append({ organizationId: ORG_B, actor: { principalType: 'human', identityId: 'w1b-id-owner-b' }, eventType: 'MEMBERSHIP_STATUS_CHANGED', targetType: 'MEMBERSHIP', targetId: `${ORG_B}::w1b-id-owner-b`, outcome: 'SUCCESS' });
      await audit.append({ actor: { principalType: 'system' }, eventType: 'IDENTITY_CREATED', targetType: 'IDENTITY', targetId: 'w1b-id-owner-a', outcome: 'SUCCESS' });
      const forA = await audit.listByOrganization(ORG_A);
      assert.equal(forA.length, 1);
      assert.equal(forA[0]!.eventId, eventA.eventId);
      assert.equal((await audit.listByOrganization(ORG_B)).length, 1);
      assert.equal((await audit.listGlobal()).length, 1, 'the global event is visible only through the global path');
      await expectSqlState(inTx(idn.pool, { org: ORG_A }, (c) => c.query(`update identity_audit_events set outcome = 'FAILURE'`)), '42501', 'app UPDATE');
      await expectSqlState(inTx(idn.pool, { org: ORG_A }, (c) => c.query(`delete from identity_audit_events`)), '42501', 'app DELETE');
      await expectSqlState(admin.pool.query(`update identity_audit_events set outcome = 'FAILURE'`), 'P0001', 'owner UPDATE');
      await expectSqlState(admin.pool.query(`delete from identity_audit_events`), 'P0001', 'owner DELETE');
      await expectSqlState(
        inTx(idn.pool, { org: ORG_A }, (c) => c.query(`insert into identity_audit_events (event_id, organization_id, actor_principal_type, actor_identity_id, event_type, target_type, target_id, outcome) values ('w1b-evt-spoof', '${ORG_B}', 'human', 'w1b-id-owner-a', 'MEMBERSHIP_STATUS_CHANGED', 'MEMBERSHIP', '${ORG_B}::x', 'SUCCESS')`)),
        '42501', 'spoofed cross-org audit insert',
      );
      assert.equal(await countRows(admin.pool, 'identity_audit_events'), 3, 'no audit event was altered or removed');
      return '3 events intact after 5 tamper attempts';
    });

    // ---- Clinic CMS connector -----------------------------------------------------------------------------------
    await reporter.check('B9 CMS connector persistence + isolation: per-org connection, reference-only secret, evidence with human and service actors, actor CHECK, cross-org and no-context denial', async () => {
      const base = { baseUrl: 'https://cms.invalid', keyId: 'w1b-key', approvedScopes: ['health:read' as const], timezone: 'Asia/Kolkata', enabled: true, createdAt: now(), updatedAt: now() };
      await connections.create({ ...base, connectionId: 'w1b-conn-A', organizationId: ORG_A, secretReference: 'env:W1B_NONEXISTENT_SECRET_A' });
      await connections.create({ ...base, connectionId: 'w1b-conn-B', organizationId: ORG_B, secretReference: 'env:W1B_NONEXISTENT_SECRET_B' });
      const forA = await connections.getEnabledForOrganization(ORG_A);
      assert.equal(forA?.connectionId, 'w1b-conn-A');
      assert.equal(forA?.secretReference, 'env:W1B_NONEXISTENT_SECRET_A', 'only a reference is stored');
      assert.equal((await connections.getEnabledForOrganization(ORG_B))?.connectionId, 'w1b-conn-B');

      const ev = (id: string, org: string, actor?: { id: string; type: 'human' | 'service' }) => ({
        evidenceId: id, organizationId: org, connectionId: org === ORG_A ? 'w1b-conn-A' : 'w1b-conn-B', connectorType: 'clinic-cms' as const, operation: 'listConsultants', correlationId: `w1b-corr-${id}`,
        outcome: 'SUCCESS' as const, retryCount: 0, actorIdentityId: actor?.id, actorPrincipalType: actor?.type, occurredAt: now(),
      });
      await evidence.record(ev('w1b-ev-human', ORG_A, { id: 'w1b-id-owner-a', type: 'human' }));
      await evidence.record(ev('w1b-ev-service', ORG_A, { id: 'w1b-id-svc-a', type: 'service' }));
      await evidence.record(ev('w1b-ev-b', ORG_B));
      const rowsA = await inTx(cms.pool, { org: ORG_A }, async (c) => (await c.query('select evidence_id, actor_identity_id, actor_principal_type from clinic_cms_connector_evidence order by evidence_id')).rows);
      assert.deepEqual(rowsA.map((r: { evidence_id: string }) => r.evidence_id), ['w1b-ev-human', 'w1b-ev-service']);
      assert.deepEqual(rowsA.map((r: { actor_principal_type: string }) => r.actor_principal_type), ['human', 'service']);
      await expectSqlState(
        inTx(cms.pool, { org: ORG_A }, (c) => c.query(`insert into clinic_cms_connector_evidence (organization_id, evidence_id, connection_id, connector_type, operation, correlation_id, outcome, retry_count, actor_principal_type) values ($1, 'w1b-ev-bad', 'w1b-conn-A', 'clinic-cms', 'x', 'w1b-c', 'SUCCESS', 0, 'robot')`, [ORG_A])),
        '23514', 'actor_principal_type CHECK',
      );
      await expectSqlState(
        inTx(cms.pool, { org: ORG_A }, (c) => c.query(`insert into clinic_cms_connections (organization_id, connection_id, base_url, key_id, secret_reference, approved_scopes, timezone, enabled) values ('${ORG_B}', 'w1b-conn-x', 'https://cms.invalid', 'k', 'env:X', '[]'::jsonb, 'Asia/Kolkata', true)`)),
        '42501', 'cross-org connection insert',
      );
      return 'A resolves only its connection; evidence keeps actor human+service; robot actor = 23514; cross-org = 42501';
    });

    // ---- communication orchestration + W2C -------------------------------------------------------------------------
    await reporter.check('B10 communication persistence + isolation: platform-global channel lookup, duplicate rejection, org-scoped conversations/messages/raw content, dedup, purge', async () => {
      const channel = (id: string, org: string, ext: string) => ({
        channelId: id, organizationId: org, provider: 'meta_whatsapp_cloud_api' as const, externalChannelId: ext, serviceIdentityId: 'w1b-id-svc-a', serviceProviderSubject: id,
        accessTokenReference: 'env:W1B_NONEXISTENT_TOKEN', displayPhoneNumber: '+000000000000', timezone: 'Asia/Kolkata', enabled: true, createdAt: now(), updatedAt: now(),
      });
      await channels.create(channel('w1b-chan-A', ORG_A, 'w1b-phone-A'));
      assert.equal((await channels.getEnabledByExternalChannelId('w1b-phone-A'))?.organizationId, ORG_A, 'platform-global lookup by external id works with no org context');
      await expectSqlState(channels.create(channel('w1b-chan-dup', ORG_B, 'w1b-phone-A')), '23505', 'duplicate external_channel_id');

      const conversation = (id: string, org: string, contact: string, state: 'AI_ACTIVE' | 'HUMAN_HANDOFF_REQUESTED') => ({
        conversationId: id, organizationId: org, channelId: 'w1b-chan-A', externalContactId: contact, state, preferredLanguage: 'en-IN' as const, bookingState: 'NEW' as const, createdAt: now(), updatedAt: now(),
      });
      await conversations.create(conversation('w1b-conv-A', ORG_A, 'w1b-contact-A', 'AI_ACTIVE'));
      await conversations.create(conversation('w1b-conv-B', ORG_B, 'w1b-contact-B', 'AI_ACTIVE'));
      assert.equal((await conversations.getByExternalContact(ORG_A, 'w1b-chan-A', 'w1b-contact-A'))?.conversationId, 'w1b-conv-A');
      assert.equal(await conversations.getByExternalContact(ORG_A, 'w1b-chan-A', 'w1b-contact-B'), null, 'A cannot resolve B`s contact');
      const updated = await conversations.update({ ...conversation('w1b-conv-A', ORG_A, 'w1b-contact-A', 'AI_ACTIVE'), bookingState: 'BOOKED', activeAppointmentId: 'w1b-apt-1', updatedAt: now() });
      assert.equal(updated.bookingState, 'BOOKED');
      assert.equal((await conversations.getById(ORG_A, 'w1b-conv-A'))?.activeAppointmentId, 'w1b-apt-1');

      await messages.record({ messageId: 'w1b-msg-A', organizationId: ORG_A, conversationId: 'w1b-conv-A', direction: 'INBOUND', messageType: 'text', createdAt: now() });
      await messages.record({ messageId: 'w1b-msg-B', organizationId: ORG_B, conversationId: 'w1b-conv-B', direction: 'INBOUND', messageType: 'text', createdAt: now() });
      assert.deepEqual((await messages.listByConversation(ORG_A, 'w1b-conv-A')).map((m) => m.messageId), ['w1b-msg-A']);
      assert.deepEqual(await messages.listByConversation(ORG_A, 'w1b-conv-B'), [], 'A cannot list B`s conversation');

      await content.record({ organizationId: ORG_A, messageId: 'w1b-msg-A', rawText: 'w1b synthetic text A', purgeAfter: computePurgeAfter() });
      await content.record({ organizationId: ORG_B, messageId: 'w1b-msg-B', rawText: 'w1b synthetic text B', purgeAfter: computePurgeAfter() });
      await content.record({ organizationId: ORG_A, messageId: 'w1b-msg-old', rawText: 'w1b expired', purgeAfter: new Date(Date.now() - 1000).toISOString() });
      assert.equal((await content.get(ORG_A, 'w1b-msg-A'))?.rawText, 'w1b synthetic text A');
      assert.equal(await content.get(ORG_A, 'w1b-msg-B'), null, 'A can never read B`s raw content, even by guessing the id');
      assert.equal(await content.purgeExpired(ORG_A), 1, 'only the expired row is purged');
      assert.equal(await content.get(ORG_A, 'w1b-msg-old'), null);
      assert.notEqual(await content.get(ORG_A, 'w1b-msg-A'), null);

      assert.equal(await dedup.reserve('meta_whatsapp_cloud_api', 'w1b-wamid-1'), true);
      assert.equal(await dedup.reserve('meta_whatsapp_cloud_api', 'w1b-wamid-1'), false, 'duplicate provider event rejected');
      await expectSqlState(comms.pool.query(`insert into webhook_event_dedup (provider, external_event_id) values ('meta_whatsapp_cloud_api', 'w1b-wamid-1')`), '23505', 'dedup unique constraint');
      await expectSqlState(inTx(comms.pool, { org: ORG_A }, (c) => c.query(`insert into conversations (organization_id, conversation_id, channel_id, external_contact_id, state, preferred_language, booking_state) values ('${ORG_B}', 'w1b-conv-x', 'w1b-chan-A', 'w1b-cx', 'AI_ACTIVE', 'en-IN', 'NEW')`)), '42501', 'cross-org conversation insert');
      return 'channel/dedup dup = 23505; A isolated from B for conversations, messages, raw content; expired content purged';
    });

    await reporter.check('B11 W2C human-handoff read path: RLS-scoped, HUMAN_HANDOFF_REQUESTED only, real timestamptz ordering + cursor pagination', async () => {
      const handoff = (id: string, org: string, contact: string, at: string) => ({
        conversationId: id, organizationId: org, channelId: 'w1b-chan-A', externalContactId: contact, state: 'HUMAN_HANDOFF_REQUESTED' as const, preferredLanguage: 'en-IN' as const, bookingState: 'NEW' as const,
        handoffTrigger: 'CMS_UNRECOVERABLE_FAILURE' as const, createdAt: at, updatedAt: at,
      });
      await conversations.create(handoff('w1b-conv-A-h1', ORG_A, 'w1b-contact-h1', '2026-01-01T00:00:01.000Z'));
      await conversations.create(handoff('w1b-conv-A-h2', ORG_A, 'w1b-contact-h2', '2026-01-01T00:00:02.000Z'));
      await conversations.create(handoff('w1b-conv-B-h1', ORG_B, 'w1b-contact-hb', '2026-01-01T00:00:03.000Z'));
      const page1 = await conversations.listHumanHandoffs(ORG_A, { limit: 1 });
      assert.deepEqual(page1.items.map((c) => c.conversationId), ['w1b-conv-A-h2'], 'newest first');
      assert.ok(page1.nextCursor, 'more pages exist');
      const page2 = await conversations.listHumanHandoffs(ORG_A, { limit: 1, cursor: page1.nextCursor });
      assert.deepEqual(page2.items.map((c) => c.conversationId), ['w1b-conv-A-h1']);
      assert.equal(page2.nextCursor, undefined);
      assert.deepEqual((await conversations.listHumanHandoffs(ORG_B, { limit: 20 })).items.map((c) => c.conversationId), ['w1b-conv-B-h1'], 'B sees only its own handoff');
      const noContext = await comms.pool.query(`select 1 from conversations where state = 'HUMAN_HANDOFF_REQUESTED'`);
      assert.equal(noContext.rows.length, 0, 'no context: the handoff rows are invisible');
      return 'A: 2 handoffs in 2 pages (AI_ACTIVE conversation excluded); B: 1; no-context: 0';
    });

    // ---- missing organization context ------------------------------------------------------------------------------
    await reporter.check('B12 missing-context fail-closed: all 12 populated tenant tables return zero rows with no context, and writes are rejected', async () => {
      const allPools = Object.values(pools);
      for (const table of TENANT_TABLES) {
        assert.ok((await countRows(admin.pool, table)) > 0, `${table}: populated (else this proof is vacuous)`);
        // By design (package test R), identity_audit_events with no context exposes ONLY its global (organization_id IS NULL) events —
        // never an organization-scoped one. Every other tenant table exposes nothing.
        const expectedVisible = table === 'identity_audit_events' ? Number(((await admin.pool.query(`select count(*)::int as n from public.${table} where organization_id is null`)).rows[0] as { n: number }).n) : 0;
        const visible = await Promise.all(allPools.map(async (pool) => Number(((await pool.query(`select count(*)::int as n from public.${table}`)).rows[0] as { n: number }).n)));
        assert.deepEqual(visible, [expectedVisible, expectedVisible, expectedVisible, expectedVisible], `${table}: no session context must expose nothing tenant-scoped`);
      }
      const orgScopedAudit = await idn.pool.query(`select count(*)::int as n from identity_audit_events where organization_id is not null`);
      assert.equal(Number((orgScopedAudit.rows[0] as { n: number }).n), 0, 'no organization-scoped audit event is visible without context');
      const spoof = await df.pool.query(`select 1 from goals where organization_id = '${ORG_A}'`);
      assert.equal(spoof.rows.length, 0, 'a WHERE clause claiming an organization does not substitute for session context');
      const writes: [Pool, string][] = [
        [df.pool, `insert into goals (organization_id, goal_id, title, description, status) values ('${ORG_A}', 'w1b-noctx', 'x', 'y', 'active')`],
        [idn.pool, `insert into organization_memberships (organization_id, identity_id, role, status) values ('${ORG_A}', 'w1b-id-owner-a', 'OWNER', 'ACTIVE')`],
        [idn.pool, `insert into identity_audit_events (event_id, organization_id, actor_principal_type, event_type, target_type, target_id, outcome) values ('w1b-evt-noctx', '${ORG_A}', 'system', 'MEMBERSHIP_STATUS_CHANGED', 'MEMBERSHIP', 'x', 'SUCCESS')`],
        [cms.pool, `insert into clinic_cms_connections (organization_id, connection_id, base_url, key_id, secret_reference, approved_scopes, timezone, enabled) values ('${ORG_A}', 'w1b-noctx', 'https://cms.invalid', 'k', 'env:X', '[]'::jsonb, 'Asia/Kolkata', true)`],
        [comms.pool, `insert into conversations (organization_id, conversation_id, channel_id, external_contact_id, state, preferred_language, booking_state) values ('${ORG_A}', 'w1b-noctx', 'w1b-chan-A', 'w1b-c', 'AI_ACTIVE', 'en-IN', 'NEW')`],
      ];
      for (const [pool, text] of writes) await expectSqlState(pool.query(text), '42501', 'no-context write');
      return '12 tables x 4 pools = 0 tenant rows visible (identity_audit_events: global events only, by design); 5 representative no-context writes = 42501';
    });

    await reporter.check('B13 synthetic-data-only: every persisted row belongs to a w1b- synthetic identifier', async () => {
      await assertOnlySynthetic(admin);
      return '16/16 tables contain only w1b- values';
    });

    await reporter.check('B14 runtime-role integrity: no pooled session ever failed to switch to samvardiq_app', async () => {
      assert.equal(roleSwitchFailures, 0, 'a session that failed SET ROLE may have run queries as the RLS-bypassing owner');
      return '0 failed role switches';
    });
  } finally {
    // ---- cleanup (always) ------------------------------------------------------------------------------------------
    await Promise.allSettled([df, idn, cms, comms].map((client) => (client.pool as Pool).end()));
    await reporter.check('B15 cleanup: only synthetic rows exist (else refuse), then all removed; tables empty; governed triggers still enabled', async () => {
      // Re-proven here, not trusted from B0/B13: if the suite aborted early or anything else wrote meanwhile, never truncate non-synthetic data.
      await assertOnlySynthetic(admin);
      await admin.pool.query(`TRUNCATE TABLE ${EXPECTED_TABLES.map((t) => `public.${t}`).join(', ')}`);
      for (const table of EXPECTED_TABLES) assert.equal(await countRows(admin.pool, table), 0, `${table}: empty after cleanup`);
      const triggers = await admin.pool.query(`select count(*)::int as n from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and not tg.tgisinternal and tg.tgenabled = 'O'`);
      assert.equal(Number((triggers.rows[0] as { n: number }).n), 3);
      return '16/16 tables empty; 3/3 triggers enabled';
    });
  }
}
