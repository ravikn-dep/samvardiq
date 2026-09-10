import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { sql } from 'drizzle-orm';

import { AuthorizationService } from '../../src/authorizationService.js';
import { DuplicateEntityError, DuplicateProviderLinkError, InactiveIdentityError, MembershipNotActiveError, MembershipNotFoundError, UnknownIdentityError } from '../../src/errors.js';
import { pgErrorCode } from '../../src/postgres/client.js';
import { PostgresIdentityRepository } from '../../src/postgres/identityRepository.js';
import { PostgresMembershipRepository } from '../../src/postgres/membershipRepository.js';
import { PostgresIdentityProviderLinkRepository } from '../../src/postgres/providerLinkRepository.js';
import type { VerifiedPrincipal } from '../../src/types.js';
import { startHarness, type Harness } from './harness.js';

const PORT = 55433;
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

async function provisionHuman(identityId: string, subject: string, organizationId: string, opts: { role?: 'OWNER' | 'MEMBER' | 'VIEWER'; status?: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' } = {}) {
  await identities.create({ identityId, principalType: 'human', displayName: identityId });
  await providerLinks.create({ identityId, provider: PROVIDER, providerSubject: subject });
  await memberships.create({ organizationId, identityId, role: opts.role ?? 'MEMBER', status: opts.status ?? 'ACTIVE' });
}

// A — migration establishes all 4 tables (IDENTITY-W6 adds identity_audit_events)
test('migration establishes all 4 tables', async () => {
  const rows = await harness.owner.pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  assert.deepEqual(
    rows.rows.map((r: { table_name: string }) => r.table_name),
    ['identities', 'identity_audit_events', 'identity_provider_links', 'organization_memberships'],
  );
});

// A (full slice) — real Postgres round trip through AuthorizationService
test('A: full real-Postgres round trip resolves a trusted context', async () => {
  await provisionHuman('id-1', 'sub-1', 'org-A', { role: 'OWNER' });

  const trusted = await service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-A' });
  assert.equal(trusted.identityId, 'id-1');
  assert.equal(trusted.role, 'OWNER');
  assert.equal(trusted.principalType, 'human');
});

// G (RLS) — org-A cannot read org-B's membership rows
test('G: organization A cannot read organization B\'s membership rows via RLS', async () => {
  await provisionHuman('id-1', 'sub-1', 'org-A');
  await provisionHuman('id-2', 'sub-2', 'org-B');

  assert.equal(await memberships.get('org-A', 'id-2'), undefined, 'org-A\'s repository call must not see org-B\'s membership');

  await harness.app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', 'org-A', true)`);
    const rows = await tx.execute(sql`select * from organization_memberships`);
    assert.equal(rows.rows.length, 1, 'only org-A\'s own membership row may be visible under org-A context');
  });
});

// H (RLS write) — org-A cannot insert a membership row claiming org-B
test('H: organization A cannot insert a membership row claiming to belong to organization B', async () => {
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
  assert.ok(caught, 'the spoofed cross-organization insert must fail');
  assert.equal(pgErrorCode(caught), '42501', 'must be an RLS policy violation');
  assert.equal(await memberships.get('org-B', 'id-1'), undefined);
});

// I — missing organization context fails closed for organization_memberships
test('I: missing organization context fails closed for both read and write on organization_memberships', async () => {
  await identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });

  const readRows = await harness.app.pool.query('select * from organization_memberships');
  assert.equal(readRows.rows.length, 0);

  let caught: unknown;
  try {
    await harness.app.pool.query(
      `insert into organization_memberships (organization_id, identity_id, role, status) values ('org-A', 'id-1', 'OWNER', 'ACTIVE')`,
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(pgErrorCode(caught), '42501');
});

// N — FK integrity: membership referencing unknown identity fails at the DB layer
test('N: a membership referencing an identity that does not exist fails closed at the database layer', async () => {
  await assert.rejects(
    memberships.create({ organizationId: 'org-A', identityId: 'id-does-not-exist', role: 'MEMBER', status: 'ACTIVE' }),
    UnknownIdentityError,
  );
});

// M — duplicate provider link rejected at the database layer
test('M: a duplicate (provider, providerSubject) link is rejected at the database layer', async () => {
  await identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await identities.create({ identityId: 'id-2', principalType: 'human', displayName: 'id-2' });
  await providerLinks.create({ identityId: 'id-1', provider: PROVIDER, providerSubject: 'sub-1' });

  await assert.rejects(
    providerLinks.create({ identityId: 'id-2', provider: PROVIDER, providerSubject: 'sub-1' }),
    DuplicateProviderLinkError,
  );
});

// P — duplicate identifiers rejected, not silently overwritten
test('P: duplicate identity/membership identifiers are rejected, not silently overwritten', async () => {
  await identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'Original' });
  await assert.rejects(
    identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'Renamed' }),
    DuplicateEntityError,
  );
  assert.equal((await identities.get('id-1'))?.displayName, 'Original');
});

// R — revoked membership takes effect on next authoritative context resolution (real Postgres)
test('R: revoking a membership via Postgres denies the very next resolution attempt', async () => {
  await provisionHuman('id-1', 'sub-1', 'org-A');

  const first = await service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-A' });
  assert.equal(first.organizationId, 'org-A');

  await memberships.updateStatus('org-A', 'id-1', 'REVOKED');

  await assert.rejects(
    service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-A' }),
    MembershipNotActiveError,
  );
});

// S — suspended identity takes effect on next context resolution (real Postgres)
test('S: suspending an identity via Postgres denies the very next resolution attempt', async () => {
  await provisionHuman('id-1', 'sub-1', 'org-A');

  const first = await service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-A' });
  assert.equal(first.identityId, 'id-1');

  await identities.updateStatus('id-1', 'suspended');

  await assert.rejects(
    service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-A' }),
    InactiveIdentityError,
  );
});

// D — no membership fails closed against real Postgres
test('D: an identity with no membership row is denied against real Postgres', async () => {
  await identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await providerLinks.create({ identityId: 'id-1', provider: PROVIDER, providerSubject: 'sub-1' });

  await assert.rejects(
    service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-A' }),
    MembershipNotFoundError,
  );
});

// I & J — multi-organization isolation against real Postgres
test('multi-org: an identity belonging to A and B resolves isolated contexts against real Postgres', async () => {
  await identities.create({ identityId: 'id-1', principalType: 'human', displayName: 'id-1' });
  await providerLinks.create({ identityId: 'id-1', provider: PROVIDER, providerSubject: 'sub-1' });
  await memberships.create({ organizationId: 'org-A', identityId: 'id-1', role: 'OWNER', status: 'ACTIVE' });
  await memberships.create({ organizationId: 'org-B', identityId: 'id-1', role: 'VIEWER', status: 'ACTIVE' });

  const contextA = await service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-A' });
  const contextB = await service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-B' });

  assert.equal(contextA.role, 'OWNER');
  assert.equal(contextB.role, 'VIEWER');
  assert.notEqual(contextA.organizationId, contextB.organizationId);
});

// T — bootstrap path cannot become a general tenant database bypass
test('T: the membership-resolution bootstrap path exposes no data beyond the requested organization\'s own membership row', async () => {
  await provisionHuman('id-1', 'sub-1', 'org-A');
  await provisionHuman('id-2', 'sub-2', 'org-B');

  // Resolve a trusted context for org-A (this is the exact bootstrap path:
  // requestedOrganizationId is untrusted input, used only to scope the check).
  await service.resolveTrustedContext({ principal: principal('sub-1'), requestedOrganizationId: 'org-A' });

  // Prove that resolving org-A's context did not leave any residual access:
  // a fresh, independent read with no context set sees nothing at all —
  // SET LOCAL is transaction-scoped and cannot leak across the pool.
  const rowsAfter = await harness.app.pool.query('select * from organization_memberships');
  assert.equal(rowsAfter.rows.length, 0, 'no context bleeds between the resolver\'s internal transaction and a fresh connection/query');

  // And a directly attempted read "as org-A" still only ever sees org-A's row,
  // never org-B's — the bootstrap check has no broader reach than any other
  // organization-scoped query in this system.
  await harness.app.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', 'org-A', true)`);
    const rows = await tx.execute(sql`select organization_id from organization_memberships`);
    assert.deepEqual(
      rows.rows.map((r) => (r as { organization_id: string }).organization_id),
      ['org-A'],
    );
  });
});
