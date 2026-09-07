import { and, eq } from 'drizzle-orm';

import { DuplicateEntityError, OrganizationNotFoundError } from '../errors.js';
import type { CreateGoalInput, GoalRepository } from '../goalRepository.js';
import type { Goal, GoalStatus } from '../types.js';
import { pgErrorCode, withOrganizationContext, type Database } from './client.js';
import { goals } from './schema.js';

export class PostgresGoalRepository implements GoalRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateGoalInput): Promise<Goal> {
    return withOrganizationContext(this.db, input.organizationId, async (tx) => {
      try {
        const [row] = await tx
          .insert(goals)
          .values({
            organizationId: input.organizationId,
            goalId: input.goalId,
            title: input.title,
            description: input.description,
            status: input.status ?? 'active',
            ownerExecutive: input.ownerExecutive,
          })
          .returning();
        return toGoal(row!);
      } catch (error) {
        const code = pgErrorCode(error);
        if (code === '23505') throw new DuplicateEntityError('Goal', input.goalId);
        // FK to organizations: the org doesn't exist (RLS would also just hide it, same net effect).
        if (code === '23503') throw new OrganizationNotFoundError(input.organizationId);
        throw error;
      }
    });
  }

  async get(organizationId: string, goalId: string): Promise<Goal | undefined> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(goals)
        .where(and(eq(goals.organizationId, organizationId), eq(goals.goalId, goalId)));
      return row ? toGoal(row) : undefined;
    });
  }

  async listByOrganization(organizationId: string): Promise<Goal[]> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx.select().from(goals).where(eq(goals.organizationId, organizationId));
      return rows.map(toGoal);
    });
  }
}

function toGoal(row: typeof goals.$inferSelect): Goal {
  return {
    goalId: row.goalId,
    organizationId: row.organizationId,
    title: row.title,
    description: row.description,
    status: row.status as GoalStatus,
    ownerExecutive: row.ownerExecutive ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
