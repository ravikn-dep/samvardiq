/** Every persistence failure fails closed via a distinct, catchable error type — never a silent success. */

export class OrganizationNotFoundError extends Error {
  constructor(organizationId: string) {
    super(`Organization "${organizationId}" does not exist.`);
    this.name = 'OrganizationNotFoundError';
  }
}

export class GoalNotFoundError extends Error {
  constructor(organizationId: string, goalId: string) {
    super(`Goal "${goalId}" does not exist under organization "${organizationId}".`);
    this.name = 'GoalNotFoundError';
  }
}

export class RecommendationNotFoundError extends Error {
  constructor(organizationId: string, recommendationId: string) {
    super(`Recommendation "${recommendationId}" does not exist under organization "${organizationId}".`);
    this.name = 'RecommendationNotFoundError';
  }
}

export class ReferentialIntegrityViolation extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ReferentialIntegrityViolation';
  }
}

export class OrganizationBoundaryViolation extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'OrganizationBoundaryViolation';
  }
}

export class DuplicateEntityError extends Error {
  constructor(entityType: string, id: string) {
    super(`${entityType} "${id}" already exists and cannot be created again.`);
    this.name = 'DuplicateEntityError';
  }
}
