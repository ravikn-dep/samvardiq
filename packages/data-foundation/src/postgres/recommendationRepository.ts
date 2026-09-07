import { and, eq } from 'drizzle-orm';

import { DuplicateEntityError, GoalNotFoundError } from '../errors.js';
import type { RecommendationRepository } from '../recommendationRepository.js';
import type { ApprovalLevel, EvidenceReference, PersistedRecommendation, PersistedRecommendationStatus, RiskLevel } from '../types.js';
import { pgErrorCode, withOrganizationContext, type Database } from './client.js';
import { recommendations } from './schema.js';

export class PostgresRecommendationRepository implements RecommendationRepository {
  constructor(private readonly db: Database) {}

  async save(record: PersistedRecommendation): Promise<PersistedRecommendation> {
    return withOrganizationContext(this.db, record.organizationId, async (tx) => {
      try {
        const [row] = await tx
          .insert(recommendations)
          .values({
            organizationId: record.organizationId,
            recommendationId: record.recommendationId,
            goalId: record.goalId,
            owningExecutive: record.owningExecutive,
            originatingSkill: record.originatingSkill,
            title: record.title,
            status: record.status,
            approvalRequirement: record.approvalRequirement,
            risk: record.risk,
            evidenceReferences: record.evidenceReferences,
            confidence: record.confidence,
          })
          .returning();
        return toRecommendation(row!);
      } catch (error) {
        const code = pgErrorCode(error);
        if (code === '23505') throw new DuplicateEntityError('Recommendation', record.recommendationId);
        if (code === '23503') throw new GoalNotFoundError(record.organizationId, record.goalId);
        throw error;
      }
    });
  }

  async get(organizationId: string, recommendationId: string): Promise<PersistedRecommendation | undefined> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(recommendations)
        .where(and(eq(recommendations.organizationId, organizationId), eq(recommendations.recommendationId, recommendationId)));
      return row ? toRecommendation(row) : undefined;
    });
  }

  async listByGoal(organizationId: string, goalId: string): Promise<PersistedRecommendation[]> {
    return withOrganizationContext(this.db, organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(recommendations)
        .where(and(eq(recommendations.organizationId, organizationId), eq(recommendations.goalId, goalId)));
      return rows.map(toRecommendation);
    });
  }
}

function toRecommendation(row: typeof recommendations.$inferSelect): PersistedRecommendation {
  return {
    recommendationId: row.recommendationId,
    organizationId: row.organizationId,
    goalId: row.goalId,
    owningExecutive: row.owningExecutive,
    originatingSkill: row.originatingSkill,
    title: row.title,
    status: row.status as PersistedRecommendationStatus,
    approvalRequirement: row.approvalRequirement as ApprovalLevel,
    risk: row.risk as RiskLevel,
    evidenceReferences: row.evidenceReferences as EvidenceReference[],
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
  };
}
