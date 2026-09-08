import { evaluatePlanForBuilder, evaluatePlanForBuilderWithLuna, type PlanEvaluation } from '../../gemma/plan-sizer-service.js';
import { antigravityModelForEffort, resolveAntigravityModel } from '../../routing/model-policy.js';
import { evaluateContextBudget } from '../../context/context-budget-evaluator.js';
import type { PipelineContext } from './types.js';

export interface SizingStageResult {
  antigravityModel: string;
  antigravityEffort: 'low' | 'medium' | 'high';
  reasoning: string;
}

/**
 * Stage 4: Post-Plan Construction Sizing (Pass 2)
 * Local Gemma reads Codex's implementation blueprint and fits
 * the builder's reasoning effort to the actual work required.
 * Promotes to Codex Luna High if blueprint exceeds local context limits.
 */
export async function runSizingStage(
  ctx: PipelineContext,
  blueprint: string,
  refinedSpec: string
): Promise<SizingStageResult> {
  if (!blueprint.trim()) {
    return {
      antigravityModel: ctx.models.antigravity,
      antigravityEffort: ctx.models.antigravityEffort || 'medium',
      reasoning: 'Default effort used in absence of blueprint.',
    };
  }

  const budget = evaluateContextBudget({
    prompt: refinedSpec,
    projectOverview: blueprint,
    capabilities: ctx.capabilities,
  });

  let planEval: PlanEvaluation;
  let usedLuna = false;

  if (budget.recommendedRefiner === 'codex-luna') {
    usedLuna = true;
    ctx.emit('codex', 'agent.started', { role: 'plan-evaluation', model: 'gpt-5.6-luna', effort: 'high' });
    try {
      planEval = await evaluatePlanForBuilderWithLuna({
        plan: blueprint,
        refinedSpec,
        projectRoot: ctx.project.root,
        signal: ctx.signal,
        onUsage: (usage) => ctx.recordProviderTelemetry('codex', usage),
      });
    } catch {
      planEval = { antigravityEffort: 'high', reasoning: 'Promoted to high effort for large blueprint.' };
    }
  } else {
    ctx.emit('gemma', 'agent.started', { phase: 'plan-evaluation', model: ctx.activeGemmaModel });

    try {
      planEval = await evaluatePlanForBuilder({
        plan: blueprint,
        refinedSpec,
        onUsage: (usage) => ctx.recordLocalProviderTelemetry(usage),
      });
    } catch {
      usedLuna = true;
      try {
        planEval = await evaluatePlanForBuilderWithLuna({
          plan: blueprint,
          refinedSpec,
          projectRoot: ctx.project.root,
          signal: ctx.signal,
          onUsage: (usage) => ctx.recordProviderTelemetry('codex', usage),
        });
      } catch {
        planEval = { antigravityEffort: 'medium', reasoning: 'Fallback reasoning effort.' };
      }
    }
  }

  const chosenAntigravity = resolveAntigravityModel(
    antigravityModelForEffort(planEval.antigravityEffort),
    ctx.antigravityModels
  ).model;

  ctx.models = {
    ...ctx.models,
    antigravity: chosenAntigravity,
    antigravityEffort: planEval.antigravityEffort,
  };
  ctx.store.updateTask(ctx.taskId, { models: JSON.stringify(ctx.models) });

  const eventAgent = usedLuna ? 'codex' : 'gemma';
  ctx.emit(eventAgent, 'agent.completed', {
    phase: 'plan-evaluation',
    antigravityModel: chosenAntigravity,
    antigravityEffort: planEval.antigravityEffort,
    reasoning: planEval.reasoning,
  });

  return {
    antigravityModel: chosenAntigravity,
    antigravityEffort: planEval.antigravityEffort,
    reasoning: planEval.reasoning,
  };
}
