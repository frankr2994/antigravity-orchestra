import { callGemma, type JsonSchema } from '../../providers/lmstudio/chat-client.js';
import { parseJson, redactSecrets } from '../agents/agent-data-utils.js';
import { codexNoRiderAppServer } from '../../codex-app-server.js';

export interface PlanEvaluation {
  antigravityEffort: 'low' | 'medium' | 'high';
  reasoning: string;
}

const PLAN_EVALUATION_SCHEMA: JsonSchema = {
  name: 'plan_evaluation',
  schema: {
    type: 'object',
    properties: {
      antigravityEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
      reasoning: { type: 'string' },
    },
    required: ['antigravityEffort', 'reasoning'],
    additionalProperties: false,
  },
};

/**
 * Use Gemma (local, free) to inspect Codex's implementation blueprint and
 * determine the appropriate Antigravity reasoning effort.
 *
 * Sizing the builder AFTER the plan is written ensures the reasoning tier
 * matches the true scope: file count, algorithmic depth, and architectural complexity.
 */
export async function evaluatePlanForBuilder(input: {
  plan: string;
  refinedSpec: string;
  onUsage?: (usage: Record<string, number>) => void;
}): Promise<PlanEvaluation> {
  const raw = await callGemma([
    {
      role: 'system',
      content: `You are the Orchestra Construction Sizer. Your job is to inspect an implementation blueprint produced by the Architect (Codex) and determine the exact reasoning effort needed for the builder agent (Antigravity).

Guidelines:
- low: 1-2 files changed, straightforward code additions, simple CSS/HTML tweaks, minimal algorithmic reasoning.
- medium: 2-5 files, standard full-stack features, new UI components with state management, unit test writing.
- high: 5+ files, complex domain modeling, concurrency, data migrations, intricate algorithms, or high-risk architectural refactors.

Return JSON only.`,
    },
    {
      role: 'user',
      content: `Implementation Specification:\n${redactSecrets(input.refinedSpec).slice(0, 4_000)}\n\nCodex Implementation Blueprint:\n${redactSecrets(input.plan).slice(0, 10_000)}`,
    },
  ], 500, 120_000, PLAN_EVALUATION_SCHEMA, false, undefined, input.onUsage);

  const value = parseJson(raw) as Record<string, unknown>;
  const effort = ['low', 'medium', 'high'].includes(String(value.antigravityEffort))
    ? String(value.antigravityEffort) as PlanEvaluation['antigravityEffort']
    : 'medium';
  const reasoning = String(value.reasoning || '').trim().slice(0, 400);

  return { antigravityEffort: effort, reasoning };
}

/**
 * Use Codex Luna (128k+ context) to size construction when blueprint is exceptionally large
 * or when local Gemma is unavailable.
 */
export async function evaluatePlanForBuilderWithLuna(input: {
  plan: string;
  refinedSpec: string;
  projectRoot: string;
  signal?: AbortSignal;
  onUsage?: (usage: unknown) => void;
}): Promise<PlanEvaluation> {
  const instruction = `You are the Orchestra Construction Sizer. Inspect this implementation blueprint produced by Codex Architect and determine the exact Antigravity builder reasoning effort needed (low, medium, or high).

Guidelines:
- low: 1-2 files changed, straightforward code additions, simple CSS/HTML tweaks, minimal algorithmic reasoning.
- medium: 2-5 files, standard full-stack features, new UI components with state management, unit test writing.
- high: 5+ files, complex domain modeling, concurrency, data migrations, intricate algorithms, or high-risk architectural refactors.

Implementation Specification:
${redactSecrets(input.refinedSpec)}

Codex Implementation Blueprint:
${redactSecrets(input.plan)}

Return raw JSON only:
{
  "antigravityEffort": "low" | "medium" | "high",
  "reasoning": "brief explanation"
}`;

  const result = await codexNoRiderAppServer.runReadOnlyTurn({
    root: input.projectRoot,
    prompt: instruction,
    model: 'gpt-5.6-luna',
    effort: 'high',
    signal: input.signal || new AbortController().signal,
    onTelemetry: input.onUsage,
  });

  const value = parseJson(result.text || '') as Record<string, unknown>;
  const effort = ['low', 'medium', 'high'].includes(String(value.antigravityEffort))
    ? String(value.antigravityEffort) as PlanEvaluation['antigravityEffort']
    : 'medium';
  const reasoning = String(value.reasoning || '').trim().slice(0, 400);

  return { antigravityEffort: effort, reasoning };
}
