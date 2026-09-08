import { refinePrompt, refinePromptWithLuna, clampToQuota, type RefinedPrompt } from '../../gemma/prompt-refinement-service.js';
import { evaluateContextBudget } from '../../context/context-budget-evaluator.js';
import { runRipwireFor } from '../../../ripwire.js';
import type { PipelineContext } from './types.js';

export interface RefinementStageResult {
  refinedSpec: string;
  phases: Array<{ name: string; description: string; priority: number }>;
  routeTarget: 'antigravity' | 'jules' | 'both';
  codexModel: string;
  codexEffort: string;
}

/**
 * Stage 2: Pre-Plan Prompt Refinement & Strategy Routing (Pass 1)
 * Transforms raw user input into an unambiguous technical spec,
 * decomposes work into verifiable phases, and chooses Codex Architect tiers.
 * 
 * Uses free Local Gemma when within context budget (<=8k/16k tokens),
 * and automatically promotes to Codex Luna High when context is large or local is offline.
 */
export async function runRefinementStage(ctx: PipelineContext): Promise<RefinementStageResult> {
  const budget = evaluateContextBudget({
    prompt: ctx.task.prompt,
    capabilities: ctx.capabilities,
  });

  // Ripwire: orient the refiner on the relevant code map before spending tokens.
  // This reduces the surface the refiner needs to guess about and improves phase
  // decomposition accuracy — especially on unfamiliar or large repositories.
  let ripwireContext = '';
  if (ctx.capabilities?.ripwire?.available) {
    try {
      const ripwireMap = await runRipwireFor(
        ctx.project.root,
        ctx.task.prompt,
        4_000,  // keep it tight for the refinement stage — ~4K toks
        ctx.signal,
      );
      if (ripwireMap) {
        ripwireContext = ripwireMap.output;
        ctx.emit('system', 'ripwire.context', {
          phase: 'refinement',
          command: ripwireMap.command,
          estimatedTokens: ripwireMap.estimatedTokens,
        });
      }
    } catch { /* degradable — refinement continues without ripwire context */ }
  }

  const codexQuota = ctx.capabilities.codex.rollingQuotaRemaining;

  let rawRefinement: RefinedPrompt;
  let usedLuna = false;

  if (budget.recommendedRefiner === 'codex-luna') {
    usedLuna = true;
    ctx.emit('codex', 'agent.started', {
      role: 'prompt-refinement',
      model: 'gpt-5.6-luna',
      effort: 'high',
      reason: budget.reason,
    });

    try {
      rawRefinement = await refinePromptWithLuna({
        prompt: ctx.task.prompt,
        projectRoot: ctx.project.root,
        codexQuotaRemaining: codexQuota,
        ripwireContext: ripwireContext || undefined,
        signal: ctx.signal,
        onUsage: (usage) => ctx.recordProviderTelemetry('codex', usage),
      });
    } catch (lunaError) {
      const message = lunaError instanceof Error ? lunaError.message : String(lunaError);
      ctx.emit('codex', 'warning', { message: `Codex Luna refinement error: ${message}` });
      return fallbackRefinement(ctx);
    }
  } else {
    ctx.emit('gemma', 'agent.started', { phase: 'prompt-refinement', model: ctx.activeGemmaModel });

    try {
      rawRefinement = await refinePrompt({
        prompt: ctx.task.prompt,
        projectRoot: ctx.project.root,
        codexQuotaRemaining: codexQuota,
        ripwireContext: ripwireContext || undefined,
        onUsage: (usage) => ctx.recordLocalProviderTelemetry(usage),
      });
    } catch (gemmaError) {
      // Automatic promotion to Codex Luna on local context overflow or error
      usedLuna = true;
      const gemmaMsg = gemmaError instanceof Error ? gemmaError.message : String(gemmaError);
      ctx.emit('system', 'task.model-takeover', {
        message: `Local model refinement hit limits (${gemmaMsg}); automatically promoting to Codex Luna High.`,
        from: 'local-gemma',
        to: 'codex-luna',
      });

      try {
        rawRefinement = await refinePromptWithLuna({
          prompt: ctx.task.prompt,
          projectRoot: ctx.project.root,
          codexQuotaRemaining: codexQuota,
          ripwireContext: ripwireContext || undefined,
          signal: ctx.signal,
          onUsage: (usage) => ctx.recordProviderTelemetry('codex', usage),
        });
      } catch {
        return fallbackRefinement(ctx);
      }
    }
  }


  let refinement: RefinedPrompt = clampToQuota(rawRefinement, codexQuota);
  if (refinement.routeTarget !== 'antigravity' && (!ctx.capabilities.jules.readyForProject || !ctx.julesBuilder)) {
    const reason = ctx.capabilities.jules.reason || 'The Jules pipeline builder is not configured.';
    ctx.emit('system', 'routing.adjustment', {
      message: `Jules or hybrid construction was requested by the refiner, but Jules is not ready for this project. Falling back to Antigravity. ${reason}`,
      from: refinement.routeTarget,
      to: 'antigravity',
    });
    refinement = { ...refinement, routeTarget: 'antigravity' };
  }

  ctx.models = {
    ...ctx.models,
    codex: refinement.recommendedCodexModel,
    codexEffort: refinement.recommendedCodexEffort,
  };
  ctx.store.updateTask(ctx.taskId, { models: JSON.stringify(ctx.models) });

  const eventAgent = usedLuna ? 'codex' : 'gemma';
  ctx.emit(eventAgent, 'agent.completed', {
    phase: 'prompt-refinement',
    phases: refinement.phases.length,
    routeTarget: refinement.routeTarget,
    codexModel: refinement.recommendedCodexModel,
    codexEffort: refinement.recommendedCodexEffort,
    reasoning: refinement.reasoning,
    refiner: usedLuna ? 'codex-luna' : 'local-gemma',
  });

  return {
    refinedSpec: refinement.refinedSpec,
    phases: refinement.phases,
    routeTarget: refinement.routeTarget,
    codexModel: refinement.recommendedCodexModel,
    codexEffort: refinement.recommendedCodexEffort,
  };
}

function fallbackRefinement(ctx: PipelineContext): RefinementStageResult {
  return {
    refinedSpec: ctx.task.prompt,
    phases: [{ name: 'Implementation', description: ctx.task.prompt, priority: 1 }],
    routeTarget: 'antigravity',
    codexModel: ctx.models.codex || 'gpt-5.6-terra',
    codexEffort: ctx.models.codexEffort || 'medium',
  };
}
