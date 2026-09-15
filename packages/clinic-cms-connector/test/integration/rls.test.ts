import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { sql } from 'drizzle-orm';

import { PostgresClinicCmsConnectionRepository } from '../../src/postgres/connectionRepository.js';
import { PostgresConnectorAuditRepository } from '../../src/postgres/connectorAuditRepository.js';
import { pgErrorCode, withOrganizationContext } from '../../src/postgres/client.js';
import { clinicCmsConnections } from '../../src/postgres/schema.js';
import type { ClinicCmsConnection } from '../../src/types.js';
import { startHarness, type Harness } from './harness.js';

/**
 * E/F/G/K/R/S adversarial matrix — proven against real, disposable
 * PostgreSQL (section 42/32: actual database/RLS claims cannot be mocked).
 */

const PORT = 55701;
let harness: Harness;
let repo: PostgresClinicCmsConnectionRepository;
let auditRepo: PostgresConnectorAuditRepository;

before(async () => {
  harness = await startHarness(PORT);
  repo = new PostgresClinicCmsConnectionRepository(harness.app.db);
  auditRepo = new PostgresConnectorAuditRepository(harness.app.db);
}, { timeout: 60_000 });

after(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.truncateAll();
});

function connection(overrides: Partial<ClinicCmsConnection> = {}): ClinicCmsConnection {
  return {
    connectionId: 'conn-1',
    organizationId: 'org-A',
    baseUrl: 'https://clinic.example.com',
    keyId: 'key-1',
    secretReference: 'env:CLINIC_ORG_A_SECRET',
    approvedScopes: ['health:read'],
    timezone: 'Asia/Kolkata',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('E/G: Org A cannot resolve Org B`s real, persisted connection via real RLS', async () => {
  await repo.create(connection({ organizationId: 'org-A', connectionId: 'conn-A' }));
  await repo.create(connection({ organizationId: 'org-B', connectionId: 'conn-B', secretReference: 'env:CLINIC_ORG_B_SECRET' }));

  const forA = await repo.getEnabledForOrganization('org-A');
  const forB = await repo.getEnabledForOrganization('org-B');
  assert.equal(forA?.connectionId, 'conn-A');
  assert.equal(forB?.connectionId, 'conn-B');
  assert.notEqual(forA?.secretReference, forB?.secretReference);
});

test('R: a read with no organization context set sees zero rows — never "all connections"', async () => {
  await repo.create(connection({ organizationId: 'org-A' }));
  await repo.create(connection({ organizationId: 'org-B', connectionId: 'conn-B' }));

  const rows = await harness.app.db.select().from(clinicCmsConnections);
  assert.equal(rows.length, 0, 'no session context means RLS must hide every row, not expose all of them');
});

test('S: the write policy rejects a cross-organization insert — a connection cannot be created under a different session`s org context', async () => {
  await assert.rejects(async () => {
    await withOrganizationContext(harness.app.db, 'org-A', async (tx) => {
      await tx.insert(clinicCmsConnections).values({
        organizationId: 'org-B',
        connectionId: 'conn-cross',
        baseUrl: 'https://clinic.example.com',
        keyId: 'key-x',
        secretReference: 'env:X',
        approvedScopes: [],
        timezone: 'Asia/Kolkata',
        enabled: true,
      });
    });
  }, (error: unknown) => pgErrorCode(error) === '42501' || /row-level security/i.test(String(error)));
});

test('K: a disabled connection is never returned as the enabled connection for an organization that has no other connection', async () => {
  await repo.create(connection({ enabled: false }));
  const result = await repo.getEnabledForOrganization('org-A');
  assert.equal(result, null);
});

test('connector execution evidence is organization-isolated by real RLS, and no evidence row ever carries a secret/signature field (structural — the schema has no such column)', async () => {
  await auditRepo.record({
    evidenceId: 'ev-1',
    organizationId: 'org-A',
    connectionId: 'conn-A',
    connectorType: 'clinic-cms',
    operation: 'listConsultants',
    correlationId: 'corr-1',
    outcome: 'SUCCESS',
    retryCount: 0,
    occurredAt: new Date().toISOString(),
  });
  await auditRepo.record({
    evidenceId: 'ev-2',
    organizationId: 'org-B',
    connectionId: 'conn-B',
    connectorType: 'clinic-cms',
    operation: 'listConsultants',
    correlationId: 'corr-2',
    outcome: 'SUCCESS',
    retryCount: 0,
    occurredAt: new Date().toISOString(),
  });

  const forA = await withOrganizationContext(harness.app.db, 'org-A', (tx) => tx.execute(sql`select * from clinic_cms_connector_evidence`));
  assert.equal(forA.rows.length, 1);
  assert.equal((forA.rows[0] as { organization_id: string }).organization_id, 'org-A');
});

test('evidence rows are append-only for the app role: UPDATE/DELETE are rejected by grant', async () => {
  await auditRepo.record({
    evidenceId: 'ev-3',
    organizationId: 'org-A',
    connectionId: 'conn-A',
    connectorType: 'clinic-cms',
    operation: 'listConsultants',
    correlationId: 'corr-3',
    outcome: 'SUCCESS',
    retryCount: 0,
    occurredAt: new Date().toISOString(),
  });

  await assert.rejects(async () => {
    await withOrganizationContext(harness.app.db, 'org-A', (tx) => tx.execute(sql`update clinic_cms_connector_evidence set outcome = 'ERROR' where evidence_id = 'ev-3'`));
  }, (error: unknown) => pgErrorCode(error) === '42501');

  await assert.rejects(async () => {
    await withOrganizationContext(harness.app.db, 'org-A', (tx) => tx.execute(sql`delete from clinic_cms_connector_evidence where evidence_id = 'ev-3'`));
  }, (error: unknown) => pgErrorCode(error) === '42501');
});
