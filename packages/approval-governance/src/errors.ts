/** Every governance failure mode fails closed via a distinct, catchable error type. */

export class ApprovalRequestNotFoundError extends Error {
  constructor(approvalRequestId: string) {
    super(`Approval request "${approvalRequestId}" does not exist.`);
    this.name = 'ApprovalRequestNotFoundError';
  }
}

export class RecommendationIntegrityError extends Error {
  constructor(detail: string) {
    super(`Approval request references an inconsistent recommendation/goal/organization: ${detail}`);
    this.name = 'RecommendationIntegrityError';
  }
}

export class InvalidApprovalStateTransitionError extends Error {
  constructor(currentStatus: string, attemptedDecision: string) {
    super(`Cannot apply decision "${attemptedDecision}" to an approval request in state "${currentStatus}".`);
    this.name = 'InvalidApprovalStateTransitionError';
  }
}

export class ApprovalRequestExpiredError extends Error {
  constructor(approvalRequestId: string) {
    super(`Approval request "${approvalRequestId}" has expired and can no longer be decided.`);
    this.name = 'ApprovalRequestExpiredError';
  }
}

export class UnknownApproverError extends Error {
  constructor(approverId: string) {
    super(`"${approverId}" is not a known approver identity.`);
    this.name = 'UnknownApproverError';
  }
}

export class OrganizationMismatchError extends Error {
  constructor(actingOrganizationId: string, requestOrganizationId: string) {
    super(
      `Organization "${actingOrganizationId}" cannot act on an approval request scoped to organization "${requestOrganizationId}".`,
    );
    this.name = 'OrganizationMismatchError';
  }
}

export class AiSelfApprovalError extends Error {
  constructor(approverId: string) {
    super(`AI identity "${approverId}" cannot approve a recommendation that requires human approval.`);
    this.name = 'AiSelfApprovalError';
  }
}

export class InsufficientAuthorityError extends Error {
  constructor(role: string, authorityLevel: number, requiredLevel: number) {
    super(`Role "${role}" (authority level ${authorityLevel}) cannot decide a level-${requiredLevel} approval.`);
    this.name = 'InsufficientAuthorityError';
  }
}

export class MissingRationaleError extends Error {
  constructor(approvalRequestId: string) {
    super(`A rationale is required to reject approval request "${approvalRequestId}".`);
    this.name = 'MissingRationaleError';
  }
}
