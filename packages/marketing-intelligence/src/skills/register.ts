import { SkillRegistry } from '../registry.js';
import { campaignAnalyticsDefinition, campaignAnalyticsHandler } from './campaignAnalytics.js';
import { cmoAdvisorDefinition, cmoAdvisorHandler } from './cmoAdvisor.js';
import { healthcareLocalGrowthDefinition, healthcareLocalGrowthHandler } from './healthcareLocalGrowth.js';
import { marketingOpsDefinition, marketingOpsHandler } from './marketingOps.js';

/** Session-1 runtime skills only — see docs/skills/SKILL_REGISTRY.md Wave 1. */
export function createMarketingSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(cmoAdvisorDefinition, cmoAdvisorHandler);
  registry.register(marketingOpsDefinition, marketingOpsHandler);
  registry.register(healthcareLocalGrowthDefinition, healthcareLocalGrowthHandler);
  registry.register(campaignAnalyticsDefinition, campaignAnalyticsHandler);
  return registry;
}
