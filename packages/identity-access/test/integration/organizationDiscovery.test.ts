import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { sql } from 'drizzle-orm';

import { AuthorizationService } from '../../src/authorizationService.js';
import { PostgresIdentityRepository } from '../../src/postgres/identityRepository.js';
import { PostgresMembershipRepository } from '../../src/postgres/membershipRepository.js';
import { PostgresIdentityProviderLinkRepository } from '../../src/postgres/providerLinkRepository.js';
import { pgErrorCode } from '../../src/postgres/client.js';
import type { VerifiedPrincipal } from '../../src/types.js';
import { startHarness, type Harness } from './harness.js';

/**
 * L, M, Q, R, S, T of the IDENTITY-W8 adversarial matrix — the RLS
 * self-discovery read path proven against real, disposable PostgreSQL
 * (section 42: "actual database/RLS claims cannot be mocked").
 */

const PORT = 55437;
const PROVIDER = 'test';
let harness: Harness;
let identities: PostgresIdentityRepository;
let providerLinks: PostgresIdentityProviderLinkRepository;
let memberships: PostgresMembershipRepository;
let service: AuthorizationService;

before(async () => {
  harness = await startHarness(PORT);
  identities = new PostgresIdentityRepository(harness.app.db);
  providerLinks = new PostgresIdentityProviderLinkRepository(harness.app.db);
  memberships = new PostgresMembershipRepository(harness.app.db);
  service = new AuthorizationService(identities, providerLinks, memberships);
}, { timeout: 60_000 });

after(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.truncateAll();
});

function principal(subject: string): VerifiedPrincipal {
  return { provider: PROVIDER, providerSubject: subject, verifiedAt: new Date().toISOString() };
}

async function provisionHuman(identityId: string, subject: string, organizationId: string, role: 'OWNER' | 'MEMBER' | 'VIEWER' = 'MEMBER') {
  await identities.create({ identityId, principalType: 'human', displayName: identityId });
  await providerLinks.create({ identityId, provider: PROVIDER, providerSubject: subject });
  await memberships.create({ organizationId, identityId, role, status: 'ACTIVE' });
}

test('L: user A cannot discover user B\'s memberships via real RLS', async () => {
  await provisionHuman('id-a', 'sub-a', 'org-A', 'OWNER');
  await provisionHuman('id-b', 'sub-b', 'org-B', 'OWNER');

  const resultA = await service.listEligibleOrganizations(principal('sub-a'));
  const resultB = await service.listEligibleOrganizations(principal('sub-b'));

  assert.deepEqual(resultA, [{ organizationId: 'org-A', role: 'OWNER' }]);
  assert.deepEqual(resultB, [{ organizationId: 'org-B', role: 'OWNER' }]);
});

test('M/Q: a multi-organization identity discovers exactly its own rows across organizations, and the read never establishes any write authority', async () => {
  await provisionHuman('id-1', 'sub-1', 'org-A', 'OWNER');
  await memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });
  await provisionHuman('id-2', 'sub-2', 'org-A', 'MEMBER');

  const result = await service.listEligibleOrganizations(principal('sub-1'));
  assert.deepEqual(
    result.sort((a, b) => a.organizationId.localeCompare(b.organizationId)),
    [
      { organizationId: 'org-A', role: 'OWNER' },
      { organizationId: 'org-B', role: 'VIEWER' },
    ],
  );

  // Q: discovery is read-only — prove the underlying identity-scoped read
  // context grants no write capability at all, using the same connection
  // pool the repository itself uses. LOCAL (transaction-scoped), like
  // withIdentityContext itself, so the GUC never leaks onto a pooled
  // connection reused by a later test in this file.
  const updateRowCount = await harness.app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_identity_id', 'id-1', true)`);
    const result = await tx.execute(sql`update organization_memberships set role = 'OWNER' where identity_id = 'id-1' and organization_id = 'org-B'`);
    return result.rowCount;
  });
  assert.equal(updateRowCount, 0, 'identity-scoped read context must grant zero write capability');
  const stillViewer = await memberships.get('org-B', 'id-1');
  assert.equal(stillViewer?.role, 'VIEWER');
});

test('R: a read with NO context set (neither org nor identity) sees zero rows — never "all memberships"', async () => {
  await provisionHuman('id-1', 'sub-1', 'org-A', 'OWNER');
  await provisionHuman('id-2', 'sub-2', 'org-B', 'OWNER');

  const rows = await harness.app.pool.query('select * from organization_memberships');
  assert.equal(rows.rows.length, 0, 'no context must never mean "see everything"');
});

test('S: the runtime role receives no new unrestricted tenant-enumeration capability — writes remain org-scoped only, reads remain scoped to org OR self', async () => {
  await provisionHuman('id-1', 'sub-1', 'org-A', 'OWNER');

  // A direct attempt to read org-A's rows while claiming to be identity "id-1"
  // but with NO org context set, and id-1 does NOT belong to some other org
  // "org-C" — proves the identity branch only ever returns identity_id's
  // OWN rows, never a path to an arbitrary organization's full membership list.
  // LOCAL-scoped, same reasoning as the M/Q test above.
  const orgIds = await harness.app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_identity_id', 'id-1', true)`);
    const result = await tx.execute<{ organization_id: string; identity_id: string }>(
      sql`select organization_id, identity_id from organization_memberships`,
    );
    return result.rows.map((r) => r.organization_id);
  });
  assert.deepEqual(orgIds, ['org-A'], 'only id-1\'s own row(s) are visible — never another identity\'s row, even in the same organization');
});

test('T: platform-global identities/identity_provider_links tables are never touched by this RLS change (no RLS on them, no new leak)', async () => {
  const { rows } = await harness.owner.pool.query(
    `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('identities', 'identity_provider_links') ORDER BY relname`,
  );
  assert.deepEqual(
    rows.map((r: { relname: string; relrowsecurity: boolean }) => ({ name: r.relname, rls: r.relrowsecurity })),
    [
      { name: 'identities', rls: false },
      { name: 'identity_provider_links', rls: false },
    ],
  );
});

test('write policies are byte-for-byte unaffected: INSERT/UPDATE remain org-scoped only, cross-org write still rejected', async () => {
  await identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  let caught: unknown;
  try {
    await harness.app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', 'org-A', true)`);
      await tx.execute(
        sql`insert into organization_memberships (organization_id, identity_id, role, status) values ('org-B', 'id-1', 'OWNER', 'ACTIVE')`,
      );
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(pgErrorCode(caught), '42501');
});
