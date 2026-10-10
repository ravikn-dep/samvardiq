import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { AuthorizationService } from '@samvardiq/identity-access';
import {
  createPostgresClient as createIdentityClient,
  PostgresIdentityProviderLinkRepository,
  PostgresIdentityRepository,
  PostgresMembershipAdministrationService,
  PostgresMembershipRepository,
} from '@samvardiq/identity-access/dist/postgres/index.js';
import { SupabaseIdentityProviderAdapter } from '@samvardiq/identity-access/dist/providers/index.js';
import { createPostgresClient as createDataFoundationClient, PostgresGoalRepository, PostgresOrganizationRepository } from '@samvardiq/data-foundation/dist/postgres/index.js';
import { EnvConnectorSecretProvider, InMemoryClinicCmsConnectionRepository, InMemoryConnectorAuditRepository } from '@samvardiq/clinic-cms-connector';
import { InMemoryCommunicationChannelRepository, InMemoryConversationRepository } from '@samvardiq/communication-orchestration';
import { GoalReadService } from '@samvardiq/application-services';

import { buildServer } from '../../src/server.js';
import { commsDeps, defaultTestConfig } from '../setup.js';
import { provisionHumanOwner, type HumanOwnerInput } from '../../scripts/provisionHumanOwner.js';
import { gbpServiceIdentityId, provisionGbpServicePrincipal } from '../../scripts/provisionGbpServicePrincipal.js';
import { gbpServicePrincipalResolver } from '@samvardiq/google-business-profile';
import { startLocalSupabaseCluster, type LocalSupabaseCluster } from '../../scripts/localSupabaseCluster.js';
import { createTestIssuer, type TestIssuer } from '../../../../packages/identity-access/test/jwksTestHelper.js';

/**
 * IDENTITY-SUPABASE-AUTH-STAGING: the operator bootstrap of a first human OWNER,
 * on a migrated + hardened Supabase-shaped cluster, then the real HTTP path
 * (real ES256 tokens → Supabase adapter → provider link → identity →
 * membership → TrustedOrganizationContext) as the samvardiq_app runtime role.
 */
const SUBJECT = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OTHER_SUBJECT = '11111111-2222-4333-8444-555555555555';
const INPUT: HumanOwnerInput = { organizationId: 'org-staging-clinic', organizationName: 'Staging Test Clinic', identityId: 'founder-staging', displayName: 'Founder (staging)', providerSubject: SUBJECT };

let cluster: LocalSupabaseCluster;
let issuer: TestIssuer;
let app: Awaited<ReturnType<typeof buildServer>>;
let identityClient: ReturnType<typeof createIdentityClient>;
let dfClient: ReturnType<typeof createDataFoundationClient>;

before(async () => {
  cluster = await startLocalSupabaseCluster(55963, { migrate: true, harden: true });
  issuer = await createTestIssuer();
  identityClient = createIdentityClient({ connectionString: cluster.appUrl, max: 4 });
  dfClient = createDataFoundationClient({ connectionString: cluster.appUrl, max: 4 });
  const identities = new PostgresIdentityRepository(identityClient.db);
  const memberships = new PostgresMembershipRepository(identityClient.db);
  const authz = new AuthorizationService(identities, new PostgresIdentityProviderLinkRepository(identityClient.db), memberships);
  const organizations = new PostgresOrganizationRepository(dfClient.db);
  app = await buildServer(
    {
      identityProvider: new SupabaseIdentityProviderAdapter({ projectUrl: issuer.projectUrl, jwksOptions: issuer.jwksOptions }),
      authz,
      organizations,
      goalReadService: new GoalReadService(new PostgresGoalRepository(dfClient.db)),
      membershipAdmin: new PostgresMembershipAdministrationService(identityClient.db, identities),
      clinicConnections: new InMemoryClinicCmsConnectionRepository(),
      clinicSecrets: new EnvConnectorSecretProvider(),
      ...commsDeps({ authz, organizations, clinicConnections: new InMemoryClinicCmsConnectionRepository(), clinicConnectorAudit: new InMemoryConnectorAuditRepository(), channels: new InMemoryCommunicationChannelRepository(), conversations: new InMemoryConversationRepository() }),
    },
    defaultTestConfig(),
  );
  await app.ready();
});
after(async () => {
  await app.close();
  await Promise.allSettled([identityClient.close(), dfClient.close()]);
  await cluster.stop();
});
beforeEach(async () => {
  await cluster.owner.pool.query('TRUNCATE organizations, identities, identity_provider_links, organization_memberships, identity_audit_events CASCADE');
});

const count = async (table: string) => Number((await cluster.owner.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

test('dry run writes nothing; --apply provisions organization, human identity, supabase link and ACTIVE OWNER atomically with system-actor audit; an exact re-run is a no-op', async () => {
  assert.equal(await provisionHumanOwner(cluster.owner, INPUT, false), 'would-provision');
  for (const t of ['organizations', 'identities', 'identity_provider_links', 'organization_memberships', 'identity_audit_events']) assert.equal(await count(t), 0, t);
  assert.equal(await provisionHumanOwner(cluster.owner, INPUT, true), 'provisioned');
  const q = async (sql: string) => (await cluster.owner.pool.query(sql)).rows;
  assert.deepEqual(await q(`select organization_id, status from organizations`), [{ organization_id: INPUT.organizationId, status: 'active' }]);
  assert.deepEqual(await q(`select identity_id, principal_type, status from identities`), [{ identity_id: INPUT.identityId, principal_type: 'human', status: 'active' }]);
  assert.deepEqual(await q(`select provider, provider_subject, identity_id from identity_provider_links`), [{ provider: 'supabase', provider_subject: SUBJECT, identity_id: INPUT.identityId }]);
  assert.deepEqual(await q(`select role, status, approver_role from organization_memberships`), [{ role: 'OWNER', status: 'ACTIVE', approver_role: null }]);
  assert.deepEqual(
    (await q(`select event_type, actor_principal_type, actor_identity_id, organization_id from identity_audit_events order by event_type`)).map((r) => [r.event_type, r.actor_principal_type, r.actor_identity_id, r.organization_id]),
    [['IDENTITY_CREATED', 'system', null, null], ['MEMBERSHIP_CREATED', 'system', null, INPUT.organizationId], ['PROVIDER_LINK_CREATED', 'system', null, null]],
  );
  const columns = (await q(`select column_name from information_schema.columns where table_name in ('identities','identity_provider_links') and column_name like '%mail%'`));
  assert.deepEqual(columns, [], 'T/U: no email is stored anywhere in identity — linking is by provider subject only');
  assert.equal(await provisionHumanOwner(cluster.owner, INPUT, true), 'already-provisioned');
  assert.equal(await count('identity_audit_events'), 3, 'the no-op re-run wrote nothing');
});

test('AE/S: the bootstrap never re-links a subject, never reuses an identity and never attaches an OWNER to an existing organization; invalid input is refused', async () => {
  await provisionHumanOwner(cluster.owner, INPUT, true);
  const refuse = (patch: Partial<HumanOwnerInput>) => assert.rejects(provisionHumanOwner(cluster.owner, { ...INPUT, ...patch }, true), (e: Error) => e.constructor.name === 'OperatorError', JSON.stringify(patch));
  await refuse({ identityId: 'someone-else' }); // same subject → other identity
  await refuse({ organizationId: 'org-other' }); // same subject → other organization
  await refuse({ providerSubject: OTHER_SUBJECT }); // identity id already exists
  await refuse({ providerSubject: OTHER_SUBJECT, identityId: 'second-owner' }); // organization already exists
  for (const bad of [{ providerSubject: 'user@example.com' }, { providerSubject: 'NOT-A-UUID' }, { organizationId: 'Org A' }, { identityId: '../x' }, { displayName: 'a\nb' }]) await refuse(bad);
  assert.deepEqual([await count('identities'), await count('identity_provider_links'), await count('organization_memberships')], [1, 1, 1]);
});

test('AD: 6 concurrent bootstraps of the same person create exactly one identity, link and OWNER membership', async () => {
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => provisionHumanOwner(cluster.owner, INPUT, true)));
  const provisioned = results.filter((r) => r.status === 'fulfilled' && r.value === 'provisioned');
  assert.equal(provisioned.length, 1);
  assert.ok(results.every((r) => r.status === 'fulfilled' || (r.reason as { code?: string }).code === '23505' || (r.reason as Error).constructor.name === 'OperatorError'));
  assert.deepEqual([await count('organizations'), await count('identities'), await count('identity_provider_links'), await count('organization_memberships')], [1, 1, 1, 1]);
});

test('P/OWNER proof over HTTP: the provisioned human authenticates, discovers exactly its organization as OWNER, and performs an OWNER-only operation', async () => {
  await provisionHumanOwner(cluster.owner, INPUT, true);
  const token = await issuer.signToken({ sub: SUBJECT, extraClaims: { email: 'founder@example.com' } });
  const me = await get('/v1/me/organizations', token);
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), [{ organizationId: INPUT.organizationId, name: INPUT.organizationName, role: 'OWNER' }]);
  await cluster.owner.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('invitee-1', 'human', 'invitee', 'active')`);
  const invite = await app.inject({ method: 'POST', url: `/v1/organizations/${INPUT.organizationId}/memberships`, headers: { authorization: `Bearer ${token}` }, payload: { targetIdentityId: 'invitee-1', role: 'VIEWER' } });
  assert.equal(invite.statusCode, 201, invite.body);
  const audit = (await cluster.owner.pool.query(`select actor_identity_id, actor_principal_type from identity_audit_events where event_type = 'MEMBERSHIP_CREATED' and target_id = $1`, [`${INPUT.organizationId}::invitee-1`])).rows;
  assert.deepEqual(audit, [{ actor_identity_id: INPUT.identityId, actor_principal_type: 'human' }]);
});

test('I/T/U/V/W/X/M: an authentic token grants nothing without a link; claims never carry role or organization; email is irrelevant; another organization is denied', async () => {
  await provisionHumanOwner(cluster.owner, INPUT, true);
  // I + U: a different subject with the SAME email and injected role/organization metadata.
  const stranger = await issuer.signToken({
    sub: OTHER_SUBJECT,
    extraClaims: { email: 'founder@example.com', role: 'service_role', app_metadata: { role: 'OWNER', organization_id: INPUT.organizationId }, user_metadata: { organizationId: INPUT.organizationId, samvardiqRole: 'OWNER' } },
  });
  const strangerMe = await get('/v1/me/organizations', stranger);
  assert.equal(strangerMe.statusCode, 200);
  assert.deepEqual(strangerMe.json(), [], 'unlinked subject: zero organizations, indistinguishable from "no access"');
  const strangerGoals = await get(`/v1/organizations/${INPUT.organizationId}/goals`, stranger);
  assert.equal(strangerGoals.statusCode, 403);
  // V/W: the real OWNER's own token carrying metadata for ANOTHER organization changes nothing.
  await cluster.owner.pool.query(`insert into organizations (organization_id, organization_type, name, status) values ('org-other', 'clinic', 'other', 'active')`);
  const injected = await issuer.signToken({ sub: SUBJECT, extraClaims: { app_metadata: { organization_id: 'org-other', role: 'OWNER' } } });
  assert.equal((await get('/v1/organizations/org-other/goals', injected)).statusCode, 403, 'M: wrong organization');
  assert.deepEqual((await get('/v1/me/organizations', injected)).json(), [{ organizationId: INPUT.organizationId, name: INPUT.organizationName, role: 'OWNER' }]);
  // X: an organization in the body cannot redirect the path's authority.
  const smuggle = await app.inject({ method: 'POST', url: `/v1/organizations/${INPUT.organizationId}/memberships`, headers: { authorization: `Bearer ${injected}` }, payload: { targetIdentityId: 'x', role: 'VIEWER', organizationId: 'org-other' } });
  assert.equal(smuggle.statusCode, 400);
  // AB: the denial for an unknown organization and for a real-but-foreign one are identical.
  const foreign = await get('/v1/organizations/org-other/goals', injected);
  const unknown = await get('/v1/organizations/org-does-not-exist/goals', injected);
  assert.deepEqual([foreign.statusCode, foreign.body], [unknown.statusCode, unknown.body]);
});

test('J/L/N/O: suspended identity, suspended membership, VIEWER and MEMBER roles are all refused the OWNER-only operation', async () => {
  await provisionHumanOwner(cluster.owner, INPUT, true);
  await cluster.owner.pool.query(`insert into identities (identity_id, principal_type, display_name, status) values ('invitee-2', 'human', 'invitee', 'active')`);
  const token = await issuer.signToken({ sub: SUBJECT });
  const invite = () => app.inject({ method: 'POST', url: `/v1/organizations/${INPUT.organizationId}/memberships`, headers: { authorization: `Bearer ${token}` }, payload: { targetIdentityId: 'invitee-2', role: 'VIEWER' } });
  const setRole = (role: string) => cluster.owner.pool.query(`update organization_memberships set role = $1 where identity_id = $2`, [role, INPUT.identityId]);
  for (const role of ['VIEWER', 'MEMBER']) {
    await setRole(role);
    assert.equal((await invite()).statusCode, 403, `${role} cannot administer membership`);
  }
  await setRole('OWNER');
  await cluster.owner.pool.query(`update organization_memberships set status = 'SUSPENDED', suspended_at = now() where identity_id = $1`, [INPUT.identityId]);
  assert.equal((await invite()).statusCode, 403, 'L: suspended membership');
  await cluster.owner.pool.query(`update organization_memberships set status = 'ACTIVE', suspended_at = null where identity_id = $1`, [INPUT.identityId]);
  await cluster.owner.pool.query(`update identities set status = 'suspended' where identity_id = $1`, [INPUT.identityId]);
  assert.equal((await invite()).statusCode, 403, 'J: suspended identity');
  assert.deepEqual((await get('/v1/me/organizations', token)).json(), []);
  assert.equal(await count(`organization_memberships where identity_id = 'invitee-2'`), 0, 'nothing was created by any refused attempt');
});

test('GBP-W1 G1: the operator provisions an existing organization’s GBP service principal (dry run, apply, idempotent) — a service MEMBER of that organization only, resolvable by the GBP resolver, refused elsewhere', async () => {
  await provisionHumanOwner(cluster.owner, INPUT, true);
  const before = await count('identity_audit_events');
  assert.equal(await provisionGbpServicePrincipal(cluster.owner, INPUT.organizationId, false), 'would-provision');
  assert.equal(await count('identity_audit_events'), before, 'dry run writes nothing');
  assert.equal(await provisionGbpServicePrincipal(cluster.owner, INPUT.organizationId, true), 'provisioned');
  assert.equal(await provisionGbpServicePrincipal(cluster.owner, INPUT.organizationId, true), 'already-provisioned');
  assert.equal(await count('identity_audit_events'), before + 3, 'identity, link and membership audited once, as the system actor');

  const authz = new AuthorizationService(new PostgresIdentityRepository(identityClient.db), new PostgresIdentityProviderLinkRepository(identityClient.db), new PostgresMembershipRepository(identityClient.db));
  const resolve = gbpServicePrincipalResolver(authz);
  const context = await resolve(INPUT.organizationId);
  assert.deepEqual({ p: context.principalType, r: context.role, o: context.organizationId, a: context.approverRole }, { p: 'service', r: 'MEMBER', o: INPUT.organizationId, a: undefined });
  await assert.rejects(resolve('another-org'), 'no principal for an organization without one');

  await assert.rejects(provisionGbpServicePrincipal(cluster.owner, 'no-such-org', true), /does not exist/);
  await assert.rejects(provisionGbpServicePrincipal(cluster.owner, 'Bad Id', true), /organization-id/);
  await cluster.owner.pool.query(`update organization_memberships set status = 'SUSPENDED' where identity_id = $1`, [gbpServiceIdentityId(INPUT.organizationId)]);
  await assert.rejects(resolve(INPUT.organizationId), 'kill switch: a suspended service membership resolves nothing');
  await assert.rejects(provisionGbpServicePrincipal(cluster.owner, INPUT.organizationId, true), /refusing to repair/);
});
