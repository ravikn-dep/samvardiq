/**
 * IDENTITY-SUPABASE-AUTH-STAGING — operator-only bootstrap of an organization's
 * FIRST human OWNER (the human counterpart of ADR-IDENTITY-002's operator-only
 * service-principal provisioning). Authentication never provisions authority
 * (ADR-IDENTITY-001: an unknown identity is denied, never auto-provisioned), and
 * the OWNER-only membership administration API can only act inside an
 * organization that already has an OWNER — this script is the one deliberate,
 * human-operated way to create that first OWNER.
 *
 * In ONE transaction it creates: the organization (active), an active human
 * identity, the Supabase provider link (provider 'supabase', subject = the
 * Supabase Auth user's UUID — never an email), and an ACTIVE OWNER membership,
 * audited as the `system` actor. It refuses if any of them already exists (it
 * never attaches an OWNER to an existing organization and never re-links a
 * subject); an exact re-run of a completed provisioning is a no-op. Dry-run by
 * default; `--apply` writes. Prints identifiers only — no email, no token.
 *
 *   SAMVARDIQ_DEPLOY_ENV=staging MIGRATION_DATABASE_URL=... npx tsx scripts/provisionHumanOwner.ts \
 *     --organization-id <id> --organization-name "<name>" --identity-id <id> --display-name "<name>" \
 *     --provider-subject <supabase-user-uuid> [--apply]
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectAdmin, describeTarget, OperatorError, requireStagingEnv, sanitizeError, type AdminPostgres } from './stagingDb.js';

export interface HumanOwnerInput {
  organizationId: string;
  organizationName: string;
  identityId: string;
  displayName: string;
  /** The Supabase Auth user's id (the JWT `sub`). */
  providerSubject: string;
}

export type ProvisionOutcome = 'would-provision' | 'provisioned' | 'already-provisioned';

const ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,120}$/;
const PROVIDER = 'supabase';

export function validateHumanOwnerInput(input: HumanOwnerInput): void {
  if (!ID.test(input.organizationId)) throw new OperatorError('organization-id must be 3-63 chars of a-z, 0-9, "-"');
  if (!ID.test(input.identityId)) throw new OperatorError('identity-id must be 3-63 chars of a-z, 0-9, "-"');
  if (!NAME.test(input.organizationName) || !NAME.test(input.displayName)) throw new OperatorError('names must be 1-120 printable characters');
  if (!UUID.test(input.providerSubject)) throw new OperatorError('provider-subject must be the Supabase user UUID (lower-case)');
}

export async function provisionHumanOwner(admin: AdminPostgres, input: HumanOwnerInput, apply: boolean): Promise<ProvisionOutcome> {
  validateHumanOwnerInput(input);
  const client = await admin.pool.connect();
  try {
    await client.query('BEGIN');
    const q = (text: string, params: unknown[] = []) => client.query(text, params);

    const link = (await q(`select identity_id from public.identity_provider_links where provider = $1 and provider_subject = $2 for update`, [PROVIDER, input.providerSubject])).rows[0];
    if (link) {
      const owner = (await q(
        `select 1 from public.organization_memberships m join public.identities i on i.identity_id = m.identity_id
          where m.organization_id = $1 and m.identity_id = $2 and m.role = 'OWNER' and m.status = 'ACTIVE' and i.status = 'active' and i.principal_type = 'human'`,
        [input.organizationId, input.identityId],
      )).rows[0];
      await q('ROLLBACK');
      if (link.identity_id === input.identityId && owner) return 'already-provisioned';
      throw new OperatorError('this provider subject is already linked to a different identity or membership — refusing to re-link');
    }
    if ((await q(`select 1 from public.identities where identity_id = $1`, [input.identityId])).rows[0]) throw new OperatorError('identity-id already exists');
    if ((await q(`select 1 from public.organizations where organization_id = $1`, [input.organizationId])).rows[0]) {
      throw new OperatorError('organization already exists — add further members through the OWNER-only membership API, not this bootstrap');
    }
    if (!apply) {
      await q('ROLLBACK');
      return 'would-provision';
    }

    await q(`insert into public.organizations (organization_id, organization_type, name, status) values ($1, 'clinic', $2, 'active')`, [input.organizationId, input.organizationName]);
    await q(`insert into public.identities (identity_id, principal_type, display_name, status) values ($1, 'human', $2, 'active')`, [input.identityId, input.displayName]);
    await q(`insert into public.identity_provider_links (provider, provider_subject, identity_id) values ($1, $2, $3)`, [PROVIDER, input.providerSubject, input.identityId]);
    await q(`insert into public.organization_memberships (organization_id, identity_id, role, status, activated_at) values ($1, $2, 'OWNER', 'ACTIVE', now())`, [input.organizationId, input.identityId]);
    const audit = (organizationId: string | null, eventType: string, targetType: string, targetId: string, metadata: object) =>
      q(
        `insert into public.identity_audit_events (event_id, organization_id, actor_identity_id, actor_principal_type, event_type, target_type, target_id, outcome, reason, metadata)
         values ($1, $2, null, 'system', $3, $4, $5, 'SUCCESS', 'operator bootstrap of first human OWNER', $6::jsonb)`,
        [randomUUID(), organizationId, eventType, targetType, targetId, JSON.stringify(metadata)],
      );
    await audit(null, 'IDENTITY_CREATED', 'IDENTITY', input.identityId, {});
    await audit(null, 'PROVIDER_LINK_CREATED', 'PROVIDER_LINK', input.identityId, {});
    await audit(input.organizationId, 'MEMBERSHIP_CREATED', 'MEMBERSHIP', `${input.organizationId}::${input.identityId}`, { toRole: 'OWNER', toStatus: 'ACTIVE' });
    await q('COMMIT');
    return 'provisioned';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value || value.startsWith('--')) throw new OperatorError(`missing --${name}`);
  return value;
}

async function main(): Promise<void> {
  const url = requireStagingEnv();
  const target = describeTarget(url);
  console.log(`Target (non-secret): host=${target.host} database=${target.database} userMatchesStaging=${target.userMatchesStaging}`);
  if (!target.userMatchesStaging) throw new OperatorError('Refusing to run: pooler username does not match the intended staging project.');
  const input: HumanOwnerInput = {
    organizationId: arg('organization-id'),
    organizationName: arg('organization-name'),
    identityId: arg('identity-id'),
    displayName: arg('display-name'),
    providerSubject: arg('provider-subject'),
  };
  const apply = process.argv.includes('--apply');
  const admin = connectAdmin(url);
  try {
    const outcome = await provisionHumanOwner(admin, input, apply);
    console.log(`${outcome}: organization=${input.organizationId} name=${JSON.stringify(input.organizationName)} identity=${input.identityId} displayName=${JSON.stringify(input.displayName)} provider=${PROVIDER} role=OWNER status=ACTIVE${apply ? '' : ' (dry run — pass --apply to write)'}`);
  } finally {
    await admin.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('provisionHumanOwner failed:', JSON.stringify(sanitizeError(error)));
    process.exitCode = 1;
  });
}
