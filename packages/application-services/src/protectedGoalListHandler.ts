import type { Goal } from '@samvardiq/data-foundation';

import { GoalReadService } from './goalReadService.js';
import { authenticateRequest, type IncomingRequest, type RequestBoundaryDependencies } from './requestBoundary.js';

/**
 * Proves the complete chain named in section 1/18: request -> auth ->
 * org authorization -> TrustedOrganizationContext -> application service
 * -> repository -> RLS. This is what a future HTTP route handler calls
 * (section 20): it never imports a `PostgresGoalRepository` or any other
 * concrete repository itself — `GoalReadService` is constructed once at
 * application wiring time (composition root) and injected here, keeping
 * "Request Boundary -> Application Service -> Repository" the only path,
 * with no shortcut from a handler straight into a repository.
 */
export async function handleListGoalsRequest(
  deps: RequestBoundaryDependencies & { goalReadService: GoalReadService },
  request: IncomingRequest,
): Promise<Goal[]> {
  const context = await authenticateRequest(deps, request);
  return deps.goalReadService.listGoals(context);
}
