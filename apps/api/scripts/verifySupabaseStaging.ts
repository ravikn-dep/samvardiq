/**
 * INFRA-W1B — staging verification entry point.
 *
 *   npx tsx scripts/verifySupabaseStaging.ts structure   # read-only: schema, journals, roles, grants, triggers, RLS, exposure, drift
 *   npx tsx scripts/verifySupabaseStaging.ts behavior --grant-set-role
 *       # synthetic-data proofs as the samvardiq_app runtime role (behaviorChecks.ts)
 *
 * `behavior` must act as `samvardiq_app`, and Supabase's `postgres` is a member
 * of that role WITHOUT the SET option. So it temporarily runs
 * `GRANT samvardiq_app TO postgres WITH SET TRUE` and always revokes it
 * afterwards, proving restoration (temporaryRoleGrant.ts). Because that is a
 * role-membership change, it is only ever done behind the operator's explicit
 * `--grant-set-role` flag; exit code 2 means the revocation could not be proven.
 *
 * Same secret discipline as the runner: no connection string, password or
 * credential-bearing error is ever printed.
 */
import { connectViaSetRole, runBehaviorSuite } from './behaviorChecks.js';
import { runDriftAudit } from './driftAudit.js';
import { runStructureChecks } from './structureChecks.js';
import { withTemporarySetRole } from './temporaryRoleGrant.js';
import { OperatorError, Reporter, connectAdmin, describeTarget, requireStagingEnv, sanitizeError } from './stagingDb.js';

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'structure' && mode !== 'behavior') throw new OperatorError('usage: verifySupabaseStaging.ts structure | behavior --grant-set-role');
  if (mode === 'behavior' && !process.argv.includes('--grant-set-role')) {
    throw new OperatorError('behavior needs the explicit --grant-set-role flag: it temporarily grants the SET option on samvardiq_app to the admin role (revoked afterwards).');
  }

  const connectionString = requireStagingEnv();
  const target = describeTarget(connectionString);
  console.log(`Target (non-secret): host=${target.host} port=${target.port} database=${target.database} userMatchesStaging=${target.userMatchesStaging}`);
  if (!target.userMatchesStaging) throw new OperatorError('Refusing to run: pooler username does not match the intended staging project.');

  const admin = connectAdmin(connectionString);
  const reporter = new Reporter();
  try {
    if (mode === 'structure') {
      await runStructureChecks(admin, reporter);
      await runDriftAudit(admin, reporter);
    } else {
      const outcome = await withTemporarySetRole(admin, reporter, () => runBehaviorSuite(admin, connectViaSetRole(connectionString), reporter));
      if (outcome.securityFailure) {
        console.error('SECURITY FAILURE: the temporary samvardiq_app SET membership could not be proven revoked and the role state restored. Stop; do not proceed to Git.');
        process.exitCode = 2;
      }
    }
  } finally {
    await admin.close();
  }
  console.log(reporter.summary(mode));
  if (reporter.failed > 0 && !process.exitCode) process.exitCode = 1;
}

main().catch((error) => {
  console.error('verifySupabaseStaging failed:', JSON.stringify(sanitizeError(error)));
  process.exitCode = 1;
});
