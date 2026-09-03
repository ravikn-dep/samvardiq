import type { ApprovalLevel, Approver, ApproverRole } from './types.js';

/**
 * Minimal role -> maximum-approvable-level mapping (docs/04_Architecture.md
 * Layer 6 "Role-Based Approval"). This is deliberately not general RBAC —
 * one flat table, no scopes, no delegation chains.
 */
export const ROLE_AUTHORITY: Record<ApproverRole, ApprovalLevel> = {
  hr_manager: 2,
  marketing_manager: 3,
  operations_manager: 3,
  finance_manager: 3,
  clinic_director: 4,
  founder: 5,
};

export interface ApproverDirectory {
  register(approver: Approver): void;
  find(organizationId: string, approverId: string): Approver | undefined;
}

/** Unknown identities are simply absent here — governance.ts treats a miss as fail-closed. */
export class InMemoryApproverDirectory implements ApproverDirectory {
  private readonly approvers = new Map<string, Approver>();

  private key(organizationId: string, approverId: string): string {
    return `${organizationId}::${approverId}`;
  }

  register(approver: Approver): void {
    this.approvers.set(this.key(approver.organizationId, approver.id), { ...approver });
  }

  find(organizationId: string, approverId: string): Approver | undefined {
    const approver = this.approvers.get(this.key(organizationId, approverId));
    return approver ? { ...approver } : undefined;
  }
}
