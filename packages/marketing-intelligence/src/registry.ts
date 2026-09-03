import type { SkillDefinition, SkillInvocation, SkillResult, SkillStatus } from './types.js';

/** Statuses that may actually be invoked. CANDIDATE/AUDITED/RETIRED fail closed. */
const INVOKABLE_STATUSES: ReadonlySet<SkillStatus> = new Set([
  'APPROVED',
  'INTEGRATED',
  'VALIDATED',
]);

export class SkillNotRegisteredError extends Error {
  constructor(skillId: string) {
    super(`Skill "${skillId}" is not registered.`);
    this.name = 'SkillNotRegisteredError';
  }
}

export class SkillNotApprovedError extends Error {
  constructor(skillId: string, status: SkillStatus) {
    super(`Skill "${skillId}" has status "${status}" and cannot be invoked.`);
    this.name = 'SkillNotApprovedError';
  }
}

export type SkillHandler = (invocation: SkillInvocation) => SkillResult;

interface RegisteredSkill {
  definition: SkillDefinition;
  handler: SkillHandler;
}

/** Runtime registry of approved Samvardiq skills (SOSA Layer 3 Expert Registry, marketing domain). */
export class SkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>();

  register(definition: SkillDefinition, handler: SkillHandler): void {
    this.skills.set(definition.id, { definition, handler });
  }

  /** Throws SkillNotRegisteredError for any skill not in the registry — never fabricates one. */
  get(skillId: string): SkillDefinition {
    const entry = this.skills.get(skillId);
    if (!entry) throw new SkillNotRegisteredError(skillId);
    return entry.definition;
  }

  has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  listByExecutive(owningExecutive: string): SkillDefinition[] {
    return [...this.skills.values()]
      .filter((s) => s.definition.owningExecutive === owningExecutive)
      .map((s) => s.definition);
  }

  listByDomain(domain: string): SkillDefinition[] {
    return [...this.skills.values()]
      .filter((s) => s.definition.domain === domain)
      .map((s) => s.definition);
  }

  invoke(skillId: string, invocation: SkillInvocation): SkillResult {
    const entry = this.skills.get(skillId);
    if (!entry) throw new SkillNotRegisteredError(skillId);
    if (!INVOKABLE_STATUSES.has(entry.definition.status)) {
      throw new SkillNotApprovedError(skillId, entry.definition.status);
    }
    return entry.handler(invocation);
  }
}
