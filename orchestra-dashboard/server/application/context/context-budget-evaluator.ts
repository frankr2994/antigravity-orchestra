import type { SystemCapabilities } from '../capabilities/environment-sensor.js';

export interface ContextBudgetAnalysis {
  estimatedTokens: number;
  localCapacity: number;
  exceedsLocalCapacity: boolean;
  recommendedRefiner: 'local-gemma' | 'codex-luna';
  reason: string;
}

/**
 * Fast conservative token estimation (~3.6 characters per token for code/JSON).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

/**
 * Evaluates whether a prompt and surrounding context will fit comfortably
 * inside the loaded local LLM context window (e.g. 8,192 or 16,384 tokens).
 * 
 * If total estimated input tokens exceed 75% of the local context limit
 * (leaving room for system prompt and generated structured JSON),
 * the task is promoted to Codex Luna High (128k+ context window).
 */
export function evaluateContextBudget(input: {
  prompt: string;
  projectOverview?: string;
  sessionContext?: string;
  capabilities: SystemCapabilities;
}): ContextBudgetAnalysis {
  const { prompt, projectOverview = '', sessionContext = '', capabilities } = input;

  const promptTokens = estimateTokens(prompt);
  const overviewTokens = estimateTokens(projectOverview);
  const sessionTokens = estimateTokens(sessionContext);
  const estimatedTokens = promptTokens + overviewTokens + sessionTokens + 500; // 500 tokens system instructions

  const isLocalOnline = capabilities.gemma.available && Boolean(capabilities.gemma.modelId);
  const localCapacity = capabilities.gemma.contextLength || 8192;
  const safeUsableLocalBudget = Math.floor(localCapacity * 0.75);

  if (!isLocalOnline) {
    return {
      estimatedTokens,
      localCapacity,
      exceedsLocalCapacity: true,
      recommendedRefiner: 'codex-luna',
      reason: 'LM Studio is offline or no local model is loaded; promoted to Codex Luna High.',
    };
  }

  if (estimatedTokens > safeUsableLocalBudget) {
    return {
      estimatedTokens,
      localCapacity,
      exceedsLocalCapacity: true,
      recommendedRefiner: 'codex-luna',
      reason: `Estimated input (${estimatedTokens.toLocaleString()} tokens) exceeds safe local capacity (${safeUsableLocalBudget.toLocaleString()} tokens of ${localCapacity.toLocaleString()}); promoted to Codex Luna High (128k+ window).`,
    };
  }

  return {
    estimatedTokens,
    localCapacity,
    exceedsLocalCapacity: false,
    recommendedRefiner: 'local-gemma',
    reason: `Fits within local context budget (${estimatedTokens.toLocaleString()} / ${localCapacity.toLocaleString()} tokens); using free Local Gemma (0 cloud tokens).`,
  };
}
