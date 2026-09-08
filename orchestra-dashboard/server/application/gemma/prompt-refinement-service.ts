import { callGemma, type JsonSchema } from '../../providers/lmstudio/chat-client.js';
import { parseJson, redactSecrets } from '../agents/agent-data-utils.js';
import { buildProjectOverview } from '../../infrastructure/filesystem/project-read-tools.js';
import { codexNoRiderAppServer } from '../../codex-app-server.js';

export interface RefinedPrompt {
  refinedSpec: string;
  phases: Array<{ name: string; description: string; priority: number }>;
  recommendedCodexModel: 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol';
  recommendedCodexEffort: 'low' | 'medium' | 'high';
  recommendedAntigravityEffort: 'low' | 'medium' | 'high';
  routeTarget: 'antigravity' | 'jules' | 'both';
  reasoning: string;
}

const CODEX_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] as const;
const EFFORTS = ['low', 'medium', 'high'] as const;
const ROUTE_TARGETS = ['antigravity', 'jules', 'both'] as const;

const PROMPT_REFINEMENT_SCHEMA: JsonSchema = {
  name: 'prompt_refinement',
  schema: {
    type: 'object',
    properties: {
      refinedSpec: { type: 'string' },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'integer' },
          },
          required: ['name', 'description', 'priority'],
          additionalProperties: false,
        },
      },
      recommendedCodexModel: { type: 'string', enum: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] },
      recommendedCodexEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
      recommendedAntigravityEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
      routeTarget: { type: 'string', enum: ['antigravity', 'jules', 'both'] },
      reasoning: { type: 'string' },
    },
    required: ['refinedSpec', 'phases', 'recommendedCodexModel', 'recommendedCodexEffort', 'recommendedAntigravityEffort', 'routeTarget', 'reasoning'],
    additionalProperties: false,
  },
};

/**
 * Use Gemma (local, free) to refine a raw user prompt into a structured,
 * unambiguous implementation specification and recommend model tiers.
 *
 * Gemma sees the user's prompt and a compact project overview (tech stack,
 * file count, key config) but NOT full file contents — it is choosing
 * strategy, not reading code.
 */
export async function refinePrompt(input: {
  prompt: string;
  projectRoot: string;
  codexQuotaRemaining?: number | null;
  ripwireContext?: string;
  onUsage?: (usage: Record<string, number>) => void;
}): Promise<RefinedPrompt> {
  let projectContext = '';
  try {
    const overview = await buildProjectOverview(input.projectRoot);
    projectContext = `Project tech stack and structure:\n${overview.slice(0, 6_000)}`;
  } catch {
    projectContext = `Project directory: ${input.projectRoot}`;
  }

  const ripwireSection = input.ripwireContext
    ? `\nRipwire codebase map (ranked symbols relevant to the task — use this to decompose phases and identify impact boundaries):\n${input.ripwireContext.slice(0, 8_000)}\n`
    : '';

  const quotaContext = input.codexQuotaRemaining != null
    ? `Codex rolling quota remaining: ${input.codexQuotaRemaining.toFixed(1)}%. ${input.codexQuotaRemaining < 10 ? 'CRITICAL: conserve Codex usage. Prefer luna/low.' : input.codexQuotaRemaining < 25 ? 'Moderate quota pressure. Prefer terra/medium.' : 'Normal quota available.'}`
    : 'Codex quota status is unknown; default to terra/medium.';

  const raw = await callGemma([
    {
      role: 'system',
      content: `You are the Orchestra Prompt Refiner. Your job is to take a user's raw feature request and transform it into a clear, actionable implementation specification for coding agents.

You MUST:
1. Rewrite the user's request into a precise, unambiguous technical specification. Remove conversational filler. Be specific about what should be built, where, and how it integrates.
2. Break the work into ordered phases. Each phase should be independently implementable and verifiable. A single small change is one phase. A large feature might be 2-4 phases.
3. Choose the right Codex model and reasoning effort for the PLANNING step:
   - gpt-5.6-luna (low): trivial fixes, typos, single-file changes
   - gpt-5.6-terra (medium): normal features, multi-file changes, moderate complexity
   - gpt-5.6-sol (high): complex architecture, security-sensitive changes, cross-cutting refactors
4. Choose the Antigravity (builder) reasoning effort level for implementation:
   - low: simple one-line fixes, small config tweaks, minimal reasoning needed
   - medium: standard features, single component edits, normal bug fixes
   - high: complex multi-file implementations, domain logic, heavy refactoring
5. Choose the route target:
   - "antigravity": local execution (default for most tasks)
   - "jules": cloud execution via GitHub PR (for background work or when user requests it)
   - "both": split work between local and cloud
6. Explain your reasoning briefly.

Do NOT invent features the user didn't ask for. Do NOT expand scope beyond what was requested. Keep the refined spec faithful to the user's intent but technically precise.

Return JSON only.`,
    },
    {
      role: 'user',
      content: `${projectContext}${ripwireSection}\n${quotaContext}\n\nUser's raw request:\n${redactSecrets(input.prompt).slice(0, 8_000)}`,
    },
  ], 1_500, 120_000, PROMPT_REFINEMENT_SCHEMA, false, undefined, input.onUsage);

  return validateRefinement(raw);
}

/**
 * Use Codex Luna (high-speed cloud, 128k+ context) for large-context tasks
 * or when local Gemma is offline or throws context overflow limits.
 */
export async function refinePromptWithLuna(input: {
  prompt: string;
  projectRoot: string;
  sessionContext?: string;
  codexQuotaRemaining?: number | null;
  ripwireContext?: string;
  signal?: AbortSignal;
  onUsage?: (usage: unknown) => void;
}): Promise<RefinedPrompt> {
  let projectContext = '';
  try {
    const overview = await buildProjectOverview(input.projectRoot);
    projectContext = `Project tech stack and structure:\n${overview.slice(0, 16_000)}`;
  } catch {
    projectContext = `Project directory: ${input.projectRoot}`;
  }

  const ripwireSection = input.ripwireContext
    ? `\nRipwire codebase map (ranked symbols relevant to the task — use this to decompose phases and identify impact boundaries):\n${input.ripwireContext.slice(0, 12_000)}\n`
    : '';

  const quotaContext = input.codexQuotaRemaining != null
    ? `Codex rolling quota remaining: ${input.codexQuotaRemaining.toFixed(1)}%.`
    : 'Codex quota status is normal.';

  const instruction = `You are the Orchestra Prompt Refiner. Transform the user's raw feature request into a precise, unambiguous technical specification for coding agents and decompose it into verifiable phases.

${projectContext}
${ripwireSection}
${quotaContext}
${input.sessionContext ? `Session Context:\n${input.sessionContext}\n` : ''}

User's raw request:
${redactSecrets(input.prompt)}

You MUST respond with valid JSON adhering to this exact schema (no markdown fences, no comments, raw JSON only):
{
  "refinedSpec": "rewritten clear technical specification",
  "phases": [
    { "name": "Phase name", "description": "Phase detail", "priority": 1 }
  ],
  "recommendedCodexModel": "gpt-5.6-terra",
  "recommendedCodexEffort": "medium",
  "recommendedAntigravityEffort": "high",
  "routeTarget": "antigravity",
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

  return validateRefinement(result.text || '');
}

function validateRefinement(raw: string): RefinedPrompt {
  const value = parseJson(raw) as Record<string, unknown>;

  const refinedSpec = String(value.refinedSpec || '').trim();
  if (!refinedSpec) throw new Error('Gemma refinement produced an empty specification.');

  const phases = (Array.isArray(value.phases) ? value.phases : []).map((phase: any, index: number) => ({
    name: String(phase.name || `Phase ${index + 1}`).slice(0, 100),
    description: String(phase.description || '').slice(0, 2_000),
    priority: Number.isInteger(phase.priority) ? phase.priority : index + 1,
  }));
  if (!phases.length) phases.push({ name: 'Implementation', description: refinedSpec, priority: 1 });

  const recommendedCodexModel = CODEX_MODELS.includes(value.recommendedCodexModel as any)
    ? value.recommendedCodexModel as RefinedPrompt['recommendedCodexModel']
    : 'gpt-5.6-terra';

  const recommendedCodexEffort = EFFORTS.includes(value.recommendedCodexEffort as any)
    ? value.recommendedCodexEffort as RefinedPrompt['recommendedCodexEffort']
    : 'medium';

  const recommendedAntigravityEffort = EFFORTS.includes(value.recommendedAntigravityEffort as any)
    ? value.recommendedAntigravityEffort as RefinedPrompt['recommendedAntigravityEffort']
    : 'medium';

  const routeTarget = ROUTE_TARGETS.includes(value.routeTarget as any)
    ? value.routeTarget as RefinedPrompt['routeTarget']
    : 'antigravity';

  const reasoning = String(value.reasoning || '').trim().slice(0, 500);

  return { refinedSpec, phases, recommendedCodexModel, recommendedCodexEffort, recommendedAntigravityEffort, routeTarget, reasoning };
}

/** Clamp Gemma's model recommendations against actual remaining quota. */
export function clampToQuota(refinement: RefinedPrompt, codexRemaining?: number | null): RefinedPrompt {
  const remaining = codexRemaining ?? 100;
  if (remaining <= 5) return { ...refinement, recommendedCodexModel: 'gpt-5.6-luna', recommendedCodexEffort: 'low' };
  if (remaining <= 15 && refinement.recommendedCodexModel === 'gpt-5.6-sol') return { ...refinement, recommendedCodexModel: 'gpt-5.6-terra', recommendedCodexEffort: 'medium' };
  return refinement;
}

export { evaluatePlanForBuilder, type PlanEvaluation } from './plan-sizer-service.js';
