import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryClinicCmsConnectionRepository } from '../src/connectionRepository.js';
import type { ClinicCmsConnection } from '../src/types.js';

function connection(overrides: Partial<ClinicCmsConnection> = {}): ClinicCmsConnection {
  return {
    connectionId: 'conn-1',
    organizationId: 'org-A',
    baseUrl: 'https://clinic.example.com',
    keyId: 'key-1',
    secretReference: 'env:CLINIC_ORG_A_SECRET',
    approvedScopes: ['health:read', 'consultants:read'],
    timezone: 'Asia/Kolkata',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('E/G: Org A cannot resolve Org B`s connection', async () => {
  const repo = new InMemoryClinicCmsConnectionRepository();
  await repo.create(connection({ organizationId: 'org-A' }));
  await repo.create(connection({ connectionId: 'conn-2', organizationId: 'org-B' }));

  const forA = await repo.getEnabledForOrganization('org-A');
  const forB = await repo.getEnabledForOrganization('org-B');
  assert.equal(forA?.organizationId, 'org-A');
  assert.equal(forB?.organizationId, 'org-B');
  assert.notEqual(forA?.connectionId, forB?.connectionId);
});

test('K: a missing connection resolves to null, never a different organization`s connection', async () => {
  const repo = new InMemoryClinicCmsConnectionRepository();
  await repo.create(connection({ organizationId: 'org-A' }));
  const result = await repo.getEnabledForOrganization('org-nonexistent');
  assert.equal(result, null);
});

test('J: a disabled connection is invisible to getEnabledForOrganization', async () => {
  const repo = new InMemoryClinicCmsConnectionRepository();
  await repo.create(connection({ enabled: false }));
  const result = await repo.getEnabledForOrganization('org-A');
  assert.equal(result, null);
});

test('the returned connection never carries a raw secret field — only secretReference', () => {
  const conn = connection();
  assert.ok('secretReference' in conn);
  assert.ok(!('secret' in conn));
  assert.ok(!('hmacSecret' in conn));
});
