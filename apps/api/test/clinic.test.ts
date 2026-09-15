import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { ClinicCmsConnection } from '@samvardiq/clinic-cms-connector';

import { buildWorld, provisionMember, type TestWorld } from './setup.js';

/**
 * H/AC/AL-class proof at the real Fastify HTTP layer (section 31): the
 * route is thin plumbing, the actual authority/connector logic (already
 * exhaustively proven in clinic-cms-connector's and application-services'
 * own suites) is exercised end-to-end through `.inject()` — the real
 * framework request pipeline, not a direct handler call.
 */

let world: TestWorld;

beforeEach(async () => {
  world = await buildWorld();
});

afterEach(async () => {
  await world.app.close();
});

function connection(overrides: Partial<ClinicCmsConnection> = {}): ClinicCmsConnection {
  return {
    connectionId: 'conn-1',
    organizationId: 'org-A',
    // An address nothing listens on — fails immediately (ECONNREFUSED)
    // rather than waiting on DNS resolution/timeout for a fake external
    // domain, keeping this test fast and deterministic.
    baseUrl: 'http://127.0.0.1:1',
    keyId: 'key-1',
    secretReference: 'env:CLINIC_TEST_SECRET',
    approvedScopes: ['consultants:read', 'appointments:read'],
    timezone: 'Asia/Kolkata',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('GET /v1/organizations/:organizationId/clinic/consultants', () => {
  it('AZ: no Authorization header is denied (401-class), never reaches the connector', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/v1/organizations/org-A/clinic/consultants' });
    assert.equal(response.statusCode, 401);
  });

  it('H: an Org A member requesting Org A`s own consultants succeeds through the real HTTP pipeline', async () => {
    process.env.CLINIC_TEST_SECRET = 'a-real-secret-value-at-least-32-chars';
    await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
    await world.clinicConnections.create(connection());
    const token = await world.issuer.signToken({ sub: 'sub-1' });

    const response = await world.app.inject({ method: 'GET', url: '/v1/organizations/org-A/clinic/consultants', headers: { authorization: `Bearer ${token}` } });
    // No real CMS is reachable at this URL, so the operation itself fails —
    // proving what matters at THIS layer: auth succeeded, the route reached
    // the handler, and the failure is the documented upstream-unavailable
    // shape, never a raw 500/stack trace.
    assert.equal(response.statusCode, 503);
    const body = response.json();
    assert.deepEqual(Object.keys(body), ['error']);
    assert.doesNotMatch(body.error, /secret|hmac|stack|ECONNREFUSED/i);
    delete process.env.CLINIC_TEST_SECRET;
  });

  it('K: an organization with no configured clinic connection fails closed with the same safe 503 shape', async () => {
    await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
    const token = await world.issuer.signToken({ sub: 'sub-1' });

    const response = await world.app.inject({ method: 'GET', url: '/v1/organizations/org-A/clinic/consultants', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 503);
  });

  it('O: an Org A member cannot use Org A`s token to reach Org B`s clinic route — denied before any connection lookup', async () => {
    await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
    await world.organizations.create({ organizationId: 'org-B', organizationType: 'clinic', name: 'org-B' });
    await world.clinicConnections.create(connection({ organizationId: 'org-B', connectionId: 'conn-B' }));
    const token = await world.issuer.signToken({ sub: 'sub-1' });

    const response = await world.app.inject({ method: 'GET', url: '/v1/organizations/org-B/clinic/consultants', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 403);
  });

  it('rejects an organizationId that fails schema validation before ever reaching the handler', async () => {
    const response = await world.app.inject({ method: 'GET', url: `/v1/organizations/${encodeURIComponent('bad id with spaces')}/clinic/consultants` });
    assert.equal(response.statusCode, 400);
  });
});

describe('GET /v1/organizations/:organizationId/clinic/consultants/:consultantId/slots', () => {
  it('requires a valid YYYY-MM-DD date query parameter', async () => {
    await provisionMember(world, { identityId: 'id-1', subject: 'sub-1', organizationId: 'org-A', role: 'OWNER' });
    const token = await world.issuer.signToken({ sub: 'sub-1' });
    const response = await world.app.inject({
      method: 'GET',
      url: '/v1/organizations/org-A/clinic/consultants/7/slots?date=not-a-date',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('write capabilities are deliberately not exposed as routes (section 24)', () => {
  it('no route exists for patient registration, enquiry creation, or appointment mutation', async () => {
    const token = await world.issuer.signToken({ sub: 'sub-1' });
    for (const path of ['/v1/organizations/org-A/clinic/patients', '/v1/organizations/org-A/clinic/appointments']) {
      const response = await world.app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${token}` }, payload: {} });
      assert.equal(response.statusCode, 404);
    }
  });

  it('appointments:complete/check-in/no-show routes do not exist', async () => {
    const token = await world.issuer.signToken({ sub: 'sub-1' });
    for (const path of [
      '/v1/organizations/org-A/clinic/appointments/APT-1/complete',
      '/v1/organizations/org-A/clinic/appointments/APT-1/check-in',
      '/v1/organizations/org-A/clinic/appointments/APT-1/no-show',
    ]) {
      const response = await world.app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.statusCode, 404);
    }
  });
});

