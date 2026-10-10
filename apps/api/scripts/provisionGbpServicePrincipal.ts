/**
 * GBP-W1 (Founder decision G1) — operator-only provisioning of an organization's
 * Google Business Profile SERVICE PRINCIPAL, the only principal that may use the
 * organization's stored Google credential (ADR-PLATFORM-001 / ADR-IDENTITY-002
 * Candidate A). Never created by a request: an OWNER's connect flow refuses
 * until an operator has run this for the organization.
 *
 * In ONE transaction it creates, for an EXISTING active organization: a
 * `principalType: 'service'` identity `svc-gbp-<organization>`, its provider
 * link (provider `samvardiq-gbp-connector`, subject = the organization ID), and
 * an ACTIVE MEMBER membership in that organization only (no approver role),
 * audited as the `system` actor. An exact re-run is a no-op; any partial or
 * conflicting state is refused, never repaired. Dry-run by default; `--apply`
 * writes. Kill switch: suspend or revoke that membership.
 *
 *   SAMVARDIQ_DEPLOY_ENV=staging MIGRATION_DATABASE_URL=... npx tsx scripts/provisionGbpServicePrincipal.ts \
 *     --organization-id <id> [--apply]
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GBP_SERVICE_PRINCIPAL_PROVIDER } from '@samvardiq/google-business-profile';

import { connectAdmin, describeTarget, OperatorError, requireStagingEnv, sanitizeError, type AdminPostgres } from './stagingDb.js';

export type ServicePrincipalOutcome = 'would-provision' | 'provisioned' | 'already-provisioned';

const ORGANIZATION_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;

export const gbpServiceIdentityId = (organizationId: string) => `svc-gbp-${organizationId}`;

export async function provisionGbpServicePrincipal(admin: AdminPostgres, organizationId: string, apply: boolean): Promise<ServicePrincipalOutcome> {
  if (!ORGANIZATION_ID.test(organizationId)) throw new OperatorError('organization-id must be 3-63 chars of a-z, 0-9, "-"');
  const identityId = gbpServiceIdentityId(organizationId);
  const client = await admin.pool.connect();
  try {
    await client.query('BEGIN');
    const q = (text: string, params: unknown[] = []) => client.query(text, params);

    const organization = (await q(`select status from public.organizations where organization_id = $1 for share`, [organizationId])).rows[0];
    if (!organization) throw new OperatorError('organization does not exist');
    if (organization.status !== 'active') throw new OperatorError('organization is not active');

    const link = (await q(`select identity_id from public.identity_provider_links where provider = $1 and provider_subject = $2 for update`, [GBP_SERVICE_PRINCIPAL_PROVIDER, organizationId])).rows[0];
    const identity = (await q(`select principal_type, status from public.identities where identity_id = $1 for update`, [identityId])).rows[0];
    const membership = (await q(`select organization_id, role, status from public.organization_memberships where identity_id = $1`, [identityId])).rows;
    if (link || identity || membership.length) {
      await q('ROLLBACK');
      const complete =
        link?.identity_id === identityId &&
        identity?.principal_type === 'service' &&
        identity?.status === 'active' &&
        membership.length === 1 &&
        membership[0].organization_id === organizationId &&
        membership[0].role === 'MEMBER' &&
        membership[0].status === 'ACTIVE';
      if (complete) return 'already-provisioned';
      throw new OperatorError('a partial, suspended or conflicting GBP service principal exists for this organization — refusing to repair it automatically');
    }
    if (!apply) {
      await q('ROLLBACK');
      return 'would-provision';
    }

    await q(`insert into public.identities (identity_id, principal_type, display_name, status) values ($1, 'service', 'Google Business Profile connector', 'active')`, [identityId]);
    await q(`insert into public.identity_provider_links (provider, provider_subject, identity_id) values ($1, $2, $3)`, [GBP_SERVICE_PRINCIPAL_PROVIDER, organizationId, identityId]);
    await q(`insert into public.organization_memberships (organization_id, identity_id, role, status, activated_at) values ($1, $2, 'MEMBER', 'ACTIVE', now())`, [organizationId, identityId]);
    const audit = (orgId: string | null, eventType: string, targetType: string, targetId: string, metadata: object) =>
      q(
        `insert into public.identity_audit_events (event_id, organization_id, actor_identity_id, actor_principal_type, event_type, target_type, target_id, outcome, reason, metadata)
         values ($1, $2, null, 'system', $3, $4, $5, 'SUCCESS', 'operator provisioning of GBP service principal', $6::jsonb)`,
        [randomUUID(), orgId, eventType, targetType, targetId, JSON.stringify(metadata)],
      );
    await audit(null, 'IDENTITY_CREATED', 'IDENTITY', identityId, {});
    await audit(null, 'PROVIDER_LINK_CREATED', 'PROVIDER_LINK', identityId, {});
    await audit(organizationId, 'MEMBERSHIP_CREATED', 'MEMBERSHIP', `${organizationId}::${identityId}`, { toRole: 'MEMBER', toStatus: 'ACTIVE' });
    await q('COMMIT');
    return 'provisioned';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const url = requireStagingEnv();
  const target = describeTarget(url);
  console.log(`Target (non-secret): host=${target.host} database=${target.database} userMatchesStaging=${target.userMatchesStaging}`);
  if (!target.userMatchesStaging) throw new OperatorError('Refusing to run: pooler username does not match the intended staging project.');
  const i = process.argv.indexOf('--organization-id');
  const organizationId = i >= 0 ? process.argv[i + 1] : undefined;
  if (!organizationId || organizationId.startsWith('--')) throw new OperatorError('missing --organization-id');
  const apply = process.argv.includes('--apply');
  const admin = connectAdmin(url);
  try {
    const outcome = await provisionGbpServicePrincipal(admin, organizationId, apply);
    console.log(`${outcome}: organization=${organizationId} identity=${gbpServiceIdentityId(organizationId)} provider=${GBP_SERVICE_PRINCIPAL_PROVIDER} role=MEMBER status=ACTIVE${apply ? '' : ' (dry run — pass --apply to write)'}`);
  } finally {
    await admin.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('provisionGbpServicePrincipal failed:', JSON.stringify(sanitizeError(error)));
    process.exitCode = 1;
  });
}
