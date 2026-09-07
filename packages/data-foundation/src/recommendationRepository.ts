import { DuplicateEntityError, GoalNotFoundError } from './errors.js';
import type { GoalRepository } from './goalRepository.js';
import type { PersistedRecommendation } from './types.js';

/** Organization-scoped by construction, same as GoalRepository. Async (DATA-W3). */
export interface RecommendationRepository {
  save(record: PersistedRecommendation): Promise<PersistedRecommendation>;
  get(organizationId: string, recommendationId: string): Promise<PersistedRecommendation | undefined>;
  listByGoal(organizationId: string, goalId: string): Promise<PersistedRecommendation[]>;
}

export class InMemoryRecommendationRepository implements RecommendationRepository {
  private readonly recommendations = new Map<string, PersistedRecommendation>();

  constructor(private readonly goals: GoalRepository) {}

  private key(organizationId: string, recommendationId: string): string {
    return `${organizationId}::${recommendationId}`;
  }

  async save(record: PersistedRecommendation): Promise<PersistedRecommendation> {
    // goals.get() is itself organization-scoped, so a goal belonging to a
    // different organization can never be "found" here — this is what makes
    // a cross-organization save fail closed, not a separate check.
    if (!(await this.goals.get(record.organizationId, record.goalId))) {
      throw new GoalNotFoundError(record.organizationId, record.goalId);
    }
    const key = this.key(record.organizationId, record.recommendationId);
    if (this.recommendations.has(key)) {
      throw new DuplicateEntityError('Recommendation', record.recommendationId);
    }
    this.recommendations.set(key, { ...record });
    return { ...record };
  }

  async get(organizationId: string, recommendationId: string): Promise<PersistedRecommendation | undefined> {
    const recommendation = this.recommendations.get(this.key(organizationId, recommendationId));
    return recommendation ? { ...recommendation } : undefined;
  }

  async listByGoal(organizationId: string, goalId: string): Promise<PersistedRecommendation[]> {
    return [...this.recommendations.values()]
      .filter((r) => r.organizationId === organizationId && r.goalId === goalId)
      .map((r) => ({ ...r }));
  }
}
