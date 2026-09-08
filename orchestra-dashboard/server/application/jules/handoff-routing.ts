import type { JulesHandoffKind, JulesHandoffModel } from '../../domain/index.js';

export interface JulesHandoffRoute {
  handler: 'deterministic' | 'gemma' | 'codex';
  model: JulesHandoffModel;
  effort: 'none' | 'low' | 'medium' | 'high';
  reason: string;
}

const TERRA_RISK = /\b(?:architecture|migration|git identity|repository identity|cross-repository|credential|authorization|authentication|complex domain|safety ambiguity)\b/i;
const SOL_RISK = /\b(?:security|concurrency|destructive|cross-repository identity|contradictory decision)\b/i;

export function routeJulesHandoff(input: {
  kind: JulesHandoffKind;
  text: string;
  gemmaInputTokens?: number;
  gemmaContextTokens?: number;
  lunaEscalation?: 'none' | 'terra' | 'sol';
  terraUnresolved?: boolean;
}): JulesHandoffRoute {
  if (input.kind === 'waiting_for_head') return { handler: 'deterministic', model: null, effort: 'none', reason: 'Waiting is governed by immutable PR-head identity.' };
  const fitsGemma = input.gemmaInputTokens !== undefined && input.gemmaContextTokens !== undefined
    && input.gemmaContextTokens > 0 && input.gemmaInputTokens <= input.gemmaContextTokens * 0.75;
  if (fitsGemma && ['user_feedback', 'paused', 'verification_repair'].includes(input.kind)) {
    return { handler: 'gemma', model: 'gemma', effort: 'low', reason: 'Bounded classification and condensation fit within 75% of local context.' };
  }
  if ((input.lunaEscalation === 'sol' || input.terraUnresolved) && SOL_RISK.test(input.text)) {
    return { handler: 'codex', model: 'gpt-5.6-sol', effort: 'high', reason: 'Terra left an exceptional safety or identity ambiguity unresolved.' };
  }
  if (input.lunaEscalation === 'terra' || TERRA_RISK.test(input.text) || SOL_RISK.test(input.text)) {
    return { handler: 'codex', model: 'gpt-5.6-terra', effort: 'medium', reason: 'Architecture, migration, identity, domain, or safety risk requires the balanced tier.' };
  }
  const effort = input.kind === 'plan_approval' ? 'medium' : 'low';
  return { handler: 'codex', model: 'gpt-5.6-luna', effort, reason: input.kind === 'plan_approval' ? 'Luna Medium is the default paid plan gate.' : 'Luna Low is the default ordinary technical handoff resolver.' };
}

export function cheaperCapacityFallback(model: JulesHandoffModel): Exclude<JulesHandoffModel, null> | 'wait' {
  if (model === 'gpt-5.6-sol') return 'gpt-5.6-terra';
  if (model === 'gpt-5.6-terra') return 'gpt-5.6-luna';
  return 'wait';
}
