import { runCodexAnalysis } from '../../../providers/codex/agent-adapter.js';
import { runRipwireFor } from '../../../ripwire.js';
import type { PipelineContext } from './types.js';

export interface ArchitectStageResult {
  blueprint: string;
}

/**
 * Stage 3: The Architect Blueprint (Single Pass)
 * Dispatches a single read-only turn to Codex Architect to produce
 * the concrete technical blueprint (files, contracts, algorithms).
 */
export async function runArchitectStage(
  ctx: PipelineContext,
  refinedSpec: string,
  model: string,
  effort: string
): Promise<ArchitectStageResult> {
  ctx.transition('reviewing');
  ctx.emit('codex', 'agent.started', { role: 'architect', model, effort });

  try {
    // Ripwire: supply Codex Architect with a deterministic codebase map (ranked symbols,
    // call graph, and complexity/churn) upfront. This eliminates blind file-reading loops
    // and searches, drastically saving Codex context tokens during planning.
    let ripwireMapContext = '';
    if (ctx.capabilities?.ripwire?.available) {
      try {
        const ripwireMap = await runRipwireFor(
          ctx.project.root,
          refinedSpec.slice(0, 500),
          6_000,
          ctx.signal,
        );
        if (ripwireMap) {
          ripwireMapContext = `\n\n## Ripwire Codebase Map (Deterministic ranked symbols & call graph)\n${ripwireMap.output}`;
          ctx.emit('system', 'ripwire.context', {
            phase: 'architect',
            command: ripwireMap.command,
            estimatedTokens: ripwireMap.estimatedTokens,
          });
        }
      } catch { /* degradable */ }
    }

    const blueprint = await runCodexAnalysis({
      root: ctx.project.root,
      prompt: `${refinedSpec}${ripwireMapContext}`,
      role: 'architect',
      model,
      effort,
      riderAvailable: ctx.riderFor('codex'),
      signal: ctx.signal,
      onOutput: (chunk) => ctx.stream('codex', chunk),
      onUsage: (usage) => ctx.recordProviderTelemetry('codex', usage),
    });

    ctx.emit('codex', 'agent.completed', {
      role: 'architect',
      summary: blueprint.slice(-4000),
    });

    return { blueprint };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.emit('codex', 'agent.failed', { role: 'architect', error: message });
    ctx.emit('codex', 'warning', {
      message: `Codex Architect planning turn ended with error; builder will proceed with the refined specification directly. ${message}`,
    });

    return { blueprint: '' };
  }
}
