import { GitFinalizationService, type GitFinalizationResult } from '../../git/git-finalization-service.js';
import type { PipelineContext } from './types.js';

export interface FinalizationStageResult {
  finalResultText: string;
  gitResult: GitFinalizationResult;
}

/**
 * Stage 8: Handoff Documentation, Git Finalization & Completion
 * Summarizes the verified diff, appends HANDOFF.md, commits explicit files,
 * pushes upstream if configured, and completes the task.
 */
export async function runFinalizationStage(
  ctx: PipelineContext,
  initialImplementationText: string,
  hadIncompleteAgentRun: boolean,
  dependencies: { finalize?: GitFinalizationService['finalize'] } = {}
): Promise<FinalizationStageResult> {
  const gitFinalizer = new GitFinalizationService(ctx.store);
  const finalize = dependencies.finalize ?? gitFinalizer.finalize.bind(gitFinalizer);
  const gitResult = await finalize(
    ctx.taskId,
    ctx.project,
    ctx.task.prompt,
    (state) => ctx.transition(state),
    (agent, type, payload) => ctx.emit(agent, type, payload as any)
  );

  const finalResultText = hadIncompleteAgentRun
    ? `Task changes were preserved, verified, and independently approved after provider recovery.\n\n${initialImplementationText}`
    : initialImplementationText;

  ctx.complete(finalResultText, 'antigravity');
  if (ctx.adoptedJulesTaskId) {
    const child = ctx.store.getTask(ctx.adoptedJulesTaskId);
    const parent = ctx.store.getTask(ctx.taskId);
    if (child && parent && ['recovery_required', 'recovering', 'review_disputed'].includes(child.state)) {
      ctx.store.updateTask(child.id, { state: 'running' });
      ctx.store.updateTask(child.id, {
        state: parent.state,
        result: `Continued and completed by hybrid parent task ${ctx.taskId}.`,
        error: null,
        commitSha: parent.commitSha,
        pushStatus: parent.pushStatus,
      });
      for (const attempt of ctx.store.manager.attempts.listByTaskId(child.id)) {
        if (attempt.state === 'WORKING') {
          ctx.store.manager.attempts.update(attempt.id, {
            state: 'COMPLETED',
            headSha: parent.commitSha,
            completedAt: new Date().toISOString(),
          });
        }
      }
      ctx.store.addEvent(child.id, 'system', 'task.state', {
        state: parent.state,
        result: `Completed by hybrid parent task ${ctx.taskId}.`,
      });
    }
  }

  return { finalResultText, gitResult };
}
