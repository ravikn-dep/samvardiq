import { DuplicateEntityError, GoalNotFoundError } from './errors.js';
import type { GoalRepository } from './goalRepository.js';
import type { PersistedRecommendation } from './types.js';

/** Organization-scoped by construction, same as GoalRepository. */
export interface RecommendationRepository {
  save(record: PersistedRecommendation): PersistedRecommendation;
  get(organizationId: string, recommendationId: string): PersistedRecommendation | undefined;
  listByGoal(organizationId: string, goalId: string): PersistedRecommendation[];
}

export class InMemoryRecommendationRepository implements RecommendationRepository {
  private readonly recommendations = new Map<string, PersistedRecommendation>();

  constructor(private readonly goals: GoalRepository) {}

  private key(organizationId: string, recommendationId: string): string {
    return `${organizationId}::${recommendationId}`;
  }

  save(record: PersistedRecommendation): PersistedRecommendation {
    // goals.get() is itself organization-scoped, so a goal belonging to a
    // different organization can never be "found" here — this is what makes
    // a cross-organization save fail closed, not a separate check.
    if (!this.goals.get(record.organizationId, record.goalId)) {
      throw new GoalNotFoundError(record.organizationId, record.goalId);
    }
    const key = this.key(record.organizationId, record.recommendationId);
    if (this.recommendations.has(key)) {
      throw new DuplicateEntityError('Recommendation', record.recommendationId);
    }
    this.recommendations.set(key, { ...record });
    return { ...record };
  }

  get(organizationId: string, recommendationId: string): PersistedRecommendation | undefined {
    const recommendation = this.recommendations.get(this.key(organizationId, recommendationId));
    return recommendation ? { ...recommendation } : undefined;
  }

  listByGoal(organizationId: string, goalId: string): PersistedRecommendation[] {
    return [...this.recommendations.values()]
      .filter((r) => r.organizationId === organizationId && r.goalId === goalId)
      .map((r) => ({ ...r }));
  }
}
