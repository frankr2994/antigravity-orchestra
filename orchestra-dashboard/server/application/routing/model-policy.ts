import type { ModelSelection, TaskClassification } from '../../types.js';

export interface QuotaTierConfig {
  antigravityModel: string;
  antigravityEffort: 'low' | 'medium' | 'high';
  codexModel: string | null;
  codexEffort: 'low' | 'medium' | 'high' | null;
}

export interface QuotaPolicy {
  tierAbove20: QuotaTierConfig;
  tier15to20: QuotaTierConfig;
  tier10to15: QuotaTierConfig;
  tier5to10: QuotaTierConfig;
  tierBelow5: QuotaTierConfig;
}

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  tierAbove20: { antigravityModel: 'gemini-3.7-flash-high', antigravityEffort: 'high', codexModel: 'gpt-5.6-sol', codexEffort: 'high' },
  tier15to20: { antigravityModel: 'gemini-3.7-flash-high', antigravityEffort: 'high', codexModel: 'gpt-5.6-terra', codexEffort: 'high' },
  tier10to15: { antigravityModel: 'gemini-3.7-flash-medium', antigravityEffort: 'medium', codexModel: 'gpt-5.6-terra', codexEffort: 'medium' },
  tier5to10: { antigravityModel: 'gemini-3.7-flash-low', antigravityEffort: 'low', codexModel: 'gpt-5.6-luna', codexEffort: 'low' },
  tierBelow5: { antigravityModel: 'gemini-3.7-flash-low', antigravityEffort: 'low', codexModel: null, codexEffort: null },
};

export function resolveQuotaTier(policy: QuotaPolicy | undefined, codexRemaining?: number | null): { config: QuotaTierConfig; tierName: string } {
  const activePolicy = policy || DEFAULT_QUOTA_POLICY;
  const remaining = codexRemaining ?? 100;
  if (remaining > 20) return { config: activePolicy.tierAbove20, tierName: '>20% quota (Normal)' };
  if (remaining > 15) return { config: activePolicy.tier15to20, tierName: '15-20% quota (Moderate)' };
  if (remaining > 10) return { config: activePolicy.tier10to15, tierName: '10-15% quota (Conservation)' };
  if (remaining > 5) return { config: activePolicy.tier5to10, tierName: '5-10% quota (Critical)' };
  return { config: activePolicy.tierBelow5, tierName: '<5% quota (Emergency)' };
}

export function deriveAntigravityEffort(model: string): 'high' | 'medium' | 'low' {
  if (/-high\b/i.test(model)) return 'high';
  if (/-low\b/i.test(model)) return 'low';
  return 'medium';
}

export function selectModels(classification: TaskClassification, failedAttempts = 0, quotaPolicy?: QuotaPolicy, codexRemaining?: number | null): ModelSelection {
  if (classification.codexRole === 'none' && !classification.mutating) {
    return { antigravity: 'gemini-3.7-flash-low', antigravityEffort: 'low', codex: null, codexEffort: null };
  }
  if (quotaPolicy) {
    const tier = resolveQuotaTier(quotaPolicy, codexRemaining);
    return {
      antigravity: tier.config.antigravityModel,
      antigravityEffort: tier.config.antigravityEffort || deriveAntigravityEffort(tier.config.antigravityModel),
      codex: tier.config.codexModel,
      codexEffort: tier.config.codexEffort,
    };
  }
  if (failedAttempts > 1 || classification.riskFlags.includes('security') || classification.riskFlags.includes('data_loss')) {
    return { antigravity: 'gemini-3.7-flash-high', antigravityEffort: 'high', codex: classification.codexRole === 'none' ? null : 'gpt-5.6-sol', codexEffort: 'high' };
  }
  if (failedAttempts === 1 || classification.complexity === 'deep' || classification.riskFlags.length > 0) {
    return { antigravity: 'gemini-3.7-flash-high', antigravityEffort: 'high', codex: classification.codexRole === 'none' ? null : 'gpt-5.6-sol', codexEffort: 'medium' };
  }
  if (classification.type === 'review' || classification.type === 'test') {
    return { antigravity: 'gemini-3.7-flash-medium', antigravityEffort: 'medium', codex: 'gpt-5.6-terra', codexEffort: 'medium' };
  }
  return { antigravity: 'gemini-3.7-flash-medium', antigravityEffort: 'medium', codex: 'gpt-5.6-terra', codexEffort: 'medium' };
}

export function resolveAntigravityModel(selected: string, available: string[]) {
  if (!available.length || available.includes(selected)) return { model: selected, warning: null };
  const fallback = ['gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low'].find((model) => available.includes(model));
  return { model: fallback || selected, warning: fallback ? `${selected} is unavailable; using ${fallback}.` : 'Unable to verify Antigravity model availability.' };
}

export function selectReviewProfile(input: {
  request: string;
  cycle: number;
  changedFileCount: number;
  triageRisk: 'low' | 'normal' | 'high';
  repeatedFindings?: boolean;
  codexRemaining?: number | null;
  quotaPolicy?: QuotaPolicy;
}) {
  if (input.quotaPolicy) {
    const tier = resolveQuotaTier(input.quotaPolicy, input.codexRemaining);
    if (tier.config.codexModel) return { model: tier.config.codexModel, effort: tier.config.codexEffort || 'medium', reason: `${tier.tierName} policy setting` };
    return { model: 'gpt-5.6-luna', effort: 'low' as const, reason: `${tier.tierName} policy setting (bypassed)` };
  }
  const explicitlySensitive = /\b(?:security|authorization|authentication|credential|secret|payment|production migration|data loss|destructive|encryption|permission)\b/i.test(input.request);
  const remaining = input.codexRemaining ?? 100;
  if (remaining <= 5) return { model: 'gpt-5.6-luna', effort: 'low' as const, reason: `critical Codex quota (${remaining.toFixed(1)}% remaining); conserving allowance with Luna Low` };
  if (remaining <= 15) return { model: 'gpt-5.6-terra', effort: 'medium' as const, reason: `low Codex quota (${remaining.toFixed(1)}% remaining); capped to Terra Medium to protect budget` };
  if (explicitlySensitive || input.cycle >= 2 || input.repeatedFindings) return { model: 'gpt-5.6-sol', effort: 'high' as const, reason: explicitlySensitive ? 'explicitly sensitive request' : 'repeated repair review' };
  if (input.triageRisk === 'high' || input.changedFileCount >= 50) return { model: 'gpt-5.6-sol', effort: 'medium' as const, reason: input.triageRisk === 'high' ? 'high-risk local triage' : 'large change set' };
  if (input.changedFileCount >= 15 || input.cycle === 1) return { model: 'gpt-5.6-terra', effort: 'high' as const, reason: 'multi-file repair review' };
  return { model: 'gpt-5.6-terra', effort: 'medium' as const, reason: 'diff-scoped implementation review' };
}
