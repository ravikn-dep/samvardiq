import { DuplicateEntityError, OrganizationNotFoundError } from './errors.js';
import type { OrganizationRepository } from './organizationRepository.js';
import type { Goal, GoalStatus } from './types.js';

export interface CreateGoalInput {
  goalId: string;
  organizationId: string;
  title: string;
  description: string;
  status?: GoalStatus;
  ownerExecutive?: string;
}

/** Every lookup is organization-scoped by construction — there is no getGoal(goalId) overload to bypass it. */
export interface GoalRepository {
  create(input: CreateGoalInput): Goal;
  get(organizationId: string, goalId: string): Goal | undefined;
  listByOrganization(organizationId: string): Goal[];
}

export class InMemoryGoalRepository implements GoalRepository {
  private readonly goals = new Map<string, Goal>();

  constructor(private readonly organizations: OrganizationRepository) {}

  private key(organizationId: string, goalId: string): string {
    return `${organizationId}::${goalId}`;
  }

  create(input: CreateGoalInput): Goal {
    if (!this.organizations.get(input.organizationId)) {
      throw new OrganizationNotFoundError(input.organizationId);
    }
    const key = this.key(input.organizationId, input.goalId);
    if (this.goals.has(key)) {
      throw new DuplicateEntityError('Goal', input.goalId);
    }
    const now = new Date().toISOString();
    const goal: Goal = {
      goalId: input.goalId,
      organizationId: input.organizationId,
      title: input.title,
      description: input.description,
      status: input.status ?? 'active',
      ownerExecutive: input.ownerExecutive,
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(key, goal);
    return { ...goal };
  }

  get(organizationId: string, goalId: string): Goal | undefined {
    const goal = this.goals.get(this.key(organizationId, goalId));
    return goal ? { ...goal } : undefined;
  }

  listByOrganization(organizationId: string): Goal[] {
    return [...this.goals.values()].filter((goal) => goal.organizationId === organizationId).map((goal) => ({ ...goal }));
  }
}
