import { runAntigravity, type AgentRunResult } from '../../../providers/antigravity/agent-adapter.js';
import { runRipwireFor, runRipwireSitu } from '../../../ripwire.js';
import type { Store } from '../../../db.js';
import type { PipelineContext } from './types.js';
import type { JulesBuilderResult } from '../jules-builder-port.js';

export interface BuilderStageResult {
  builderTarget: 'antigravity' | 'jules' | 'both';
  agentResult: AgentRunResult;
  hadIncompleteRun: boolean;
  julesResult?: JulesBuilderResult;
}

function latestAntigravityInputTokens(store: Store, projectId: string, sessionId: string, excludeTaskId: string): number | null {
  for (const task of store.listTasks(projectId)) {
    if (task.id === excludeTaskId || task.sessionId !== sessionId) continue;
    const event = store.listEvents(task.id).findLast((item) => item.agent === 'antigravity' && item.type === 'provider.telemetry');
    const payload = event?.payload as Record<string, any> | undefined;
    const tokens = Number(payload?.usage?.input_tokens);
    if (Number.isFinite(tokens)) return tokens;
  }
  return null;
}

/**
 * Stage 5: The Builder Execution (Antigravity / Jules / Both)
 * Executes the blueprint using the exact sized reasoning tier.
 */
export async function runBuilderStage(input: {
  ctx: PipelineContext;
  refinedSpec: string;
  blueprint: string;
  builderTarget: 'antigravity' | 'jules' | 'both';
  antigravityModel: string;
  antigravityEffort: string;
}, dependencies: { runAntigravity: typeof runAntigravity } = { runAntigravity }): Promise<BuilderStageResult> {
  const { ctx, refinedSpec, blueprint, builderTarget, antigravityModel, antigravityEffort } = input;

  ctx.transition('running');
  let julesResult: JulesBuilderResult | undefined;
  if (builderTarget === 'jules' || builderTarget === 'both') {
    if (!ctx.julesBuilder) throw new Error('Jules construction was selected, but no Jules pipeline builder is configured.');
    ctx.emit('jules', 'agent.started', { phase: 'implementation', builderTarget, provider: 'jules' });
    julesResult = await ctx.julesBuilder.dispatchAndWait({
      parentTaskId: ctx.taskId,
      projectId: ctx.project.id,
      sessionId: ctx.session.id,
      projectRoot: ctx.project.root,
      prompt: [refinedSpec, blueprint ? `Implementation blueprint:\n${blueprint}` : ''].filter(Boolean).join('\n\n'),
      signal: ctx.signal,
    });
    ctx.adoptedJulesTaskId = julesResult.taskId;
    ctx.store.updateTask(ctx.taskId, { commitSha: julesResult.commitSha, pushStatus: 'pushed' });
    ctx.emit('jules', 'agent.completed', {
      phase: 'implementation',
      childTaskId: julesResult.taskId,
      commitSha: julesResult.commitSha,
      requiredLocalRepair: julesResult.requiredLocalRepair,
    });
    if (builderTarget === 'jules' && !julesResult.requiredLocalRepair) {
      const agentResult: AgentRunResult = {
        text: julesResult.result,
        conversationId: null,
        raw: '',
        warning: null,
        usage: null,
        terminalStatus: 'COMPLETED',
        incomplete: false,
        failureReason: null,
        continuationGuidance: null,
      };
      return { builderTarget, agentResult, hadIncompleteRun: false, julesResult };
    }
  }

  ctx.emit('antigravity', 'agent.started', {
    phase: 'implementation',
    model: antigravityModel,
    effort: antigravityEffort,
    builderTarget,
  });

  const implementationContext = [
    blueprint,
    julesResult ? `Jules builder result:\n${julesResult.result}\nIntegrated or imported commit: ${julesResult.commitSha}\n${julesResult.requiredLocalRepair ? 'Independent review requested local repair; inspect and correct the imported Jules result.' : 'Continue implementation on top of the reviewed Jules result.'}` : '',
    ctx.recoveryReason ? `The previous automatic run paused for this reason:\n${ctx.recoveryReason}` : '',
  ].filter(Boolean).join('\n\n');

  // Ripwire: give Antigravity a task-oriented code map + blast radius before it starts editing.
  // --for orients it on the relevant symbols; --situ shows the current working-tree impact.
  // Both are cheap (<1s each) and save many rounds of blind grepping inside the agent turn.
  let ripwireBuilderContext = '';
  if (ctx.capabilities?.ripwire?.available) {
    try {
      const [forResult, situResult] = await Promise.allSettled([
        runRipwireFor(ctx.project.root, refinedSpec.slice(0, 500), 6_000, ctx.signal),
        runRipwireSitu(ctx.project.root, ctx.signal),
      ]);
      const parts: string[] = [];
      if (forResult.status === 'fulfilled' && forResult.value) {
        parts.push(`## Ripwire task map (ranked relevant symbols)\n${forResult.value.output}`);
        ctx.emit('system', 'ripwire.context', { phase: 'builder', command: forResult.value.command, estimatedTokens: forResult.value.estimatedTokens });
      }
      if (situResult.status === 'fulfilled' && situResult.value) {
        parts.push(`## Ripwire situational awareness (working-tree blast radius)\n${situResult.value.output}`);
      }
      ripwireBuilderContext = parts.join('\n\n');
    } catch { /* degradable */ }
  }


  const priorInputTokens = latestAntigravityInputTokens(ctx.store, ctx.project.id, ctx.session.id, ctx.taskId);
  const rotateConversation = priorInputTokens !== null && priorInputTokens >= 200_000;
  const conversationId = rotateConversation ? null : ctx.session.antigravityConversationId;

  let agentResult: AgentRunResult;
  try {
    agentResult = await dependencies.runAntigravity({
      root: ctx.project.root,
      prompt: refinedSpec,
      model: antigravityModel,
      effort: antigravityEffort,
      mutating: ctx.classification.mutating,
      conversationId,
      context: [implementationContext, ripwireBuilderContext].filter(Boolean).join('\n\n'),
      recovery: ctx.recovery,
      riderAvailable: ctx.riderFor('antigravity'),
      signal: ctx.signal,
      onOutput: (chunk) => ctx.stream('antigravity', chunk),
      onUsage: (usage) => ctx.recordProviderTelemetry('antigravity', usage),
    });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    agentResult = {
      text: `Antigravity turn did not complete: ${reason}`,
      conversationId: null,
      raw: '',
      warning: `Antigravity implementation turn ended with error: ${reason}`,
      usage: null,
      terminalStatus: 'ERROR',
      incomplete: true,
      failureReason: reason,
      continuationGuidance: null,
    };
  }

  if (agentResult.conversationId) ctx.store.setConversationId(ctx.session.id, agentResult.conversationId);
  if (agentResult.warning) ctx.emit('antigravity', 'warning', { message: agentResult.warning });

  if (agentResult.incomplete) {
    ctx.emit('system', 'task.provider-recovery', {
      message: `Antigravity ended with status ${agentResult.terminalStatus || 'ERROR'}. Orchestra is inspecting the working tree for preserved changes to continue into review.`,
      provider: 'antigravity',
      status: agentResult.terminalStatus,
    });
  } else {
    ctx.emit('antigravity', 'agent.completed', { summary: agentResult.text.slice(-5000) });
  }

  return {
    builderTarget,
    agentResult,
    hadIncompleteRun: agentResult.incomplete,
    julesResult,
  };
}
