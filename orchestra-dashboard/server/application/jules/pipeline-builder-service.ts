import type { Store } from '../../db.js';
import { getGitStatus } from '../../git.js';
import { config } from '../../config.js';
import type { JulesBuilderPort, JulesBuilderResult } from '../tasks/jules-builder-port.js';
import type { JulesSessionService } from './session-service.js';

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('Jules pipeline wait was cancelled.'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Jules pipeline wait was cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, config.jules.pollIntervalMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Dispatches a durable child Jules task and waits for the existing supervisor
 * to verify and integrate its exact PR head. The local parent remains the
 * foreground owner and can continue with Antigravity on the integrated head.
 */
export class JulesPipelineBuilderService implements JulesBuilderPort {
  constructor(private readonly store: Store, private readonly sessions: JulesSessionService) {}

  async dispatchAndWait(input: Parameters<JulesBuilderPort['dispatchAndWait']>[0]): Promise<JulesBuilderResult> {
    const response = await this.sessions.dispatch(input.projectId, {
      prompt: input.prompt,
      sessionId: input.sessionId,
      requirePlanApproval: true,
      autoPr: true,
      recordUserMessage: false,
      idempotencyKey: `pipeline-jules:${input.parentTaskId}`,
    });
    const childTaskId = String(response.taskId);
    this.store.manager.checkpoints.append({
      taskId: childTaskId,
      stage: 'pipeline_child',
      data: { parentTaskId: input.parentTaskId, mode: 'builder' },
    });

    const deadline = Date.now() + config.jules.pipelineTimeoutMs;
    while (Date.now() < deadline) {
      if (input.signal.aborted) throw input.signal.reason ?? new Error('Jules pipeline wait was cancelled.');
      const child = this.store.getTask(childTaskId);
      if (!child) throw new Error('The durable Jules child task disappeared while the pipeline was waiting.');

      if (child.state === 'completed' || child.state === 'completed_unpushed') {
        if (!child.commitSha || child.pushStatus !== 'pushed') {
          throw new Error('Jules completed without a proven pushed commit identity.');
        }
        const status = await getGitStatus(input.projectRoot);
        if (!status.head || status.head.toLowerCase() !== child.commitSha.toLowerCase()) {
          throw new Error('The reviewed Jules commit was integrated remotely but is not the current local project head.');
        }
        return {
          taskId: childTaskId,
          commitSha: child.commitSha,
          result: child.result || `Jules integrated reviewed commit ${child.commitSha.slice(0, 8)}.`,
          requiredLocalRepair: false,
        };
      }

      if (child.state === 'recovery_required' || child.state === 'recovering') {
        const takeover = this.store.manager.checkpoints.latest(childTaskId, 'local_takeover');
        if (!takeover?.subjectSha) throw new Error(child.error || 'Jules requested local repair without a recoverable commit identity.');
        const status = await getGitStatus(input.projectRoot);
        if (!status.head || status.head.toLowerCase() !== takeover.subjectSha.toLowerCase()) {
          throw new Error('The Jules local-repair head is not checked out in the authoritative project.');
        }
        return {
          taskId: childTaskId,
          commitSha: takeover.subjectSha,
          result: child.error || `Jules prepared commit ${takeover.subjectSha.slice(0, 8)} for local repair.`,
          requiredLocalRepair: true,
        };
      }

      if (['failed', 'cancelled', 'review_disputed'].includes(child.state)) {
        throw new Error(child.error || `Jules child task ended in ${child.state.replaceAll('_', ' ')}.`);
      }
      await waitForNextPoll(input.signal);
    }
    throw new Error(`Jules did not reach an integrated or locally recoverable result within ${Math.round(config.jules.pipelineTimeoutMs / 60_000)} minutes.`);
  }
}
