import type { Store } from '../db.js';
import { getGitStatus } from '../git.js';
import { isOrchestraInternalPath } from '../projects.js';
import { codexCapacityRetryDelay, isCodexCapacityFailure, parseCodexCapacityRetry } from '../application/tasks/task-execution-coordinator.js';

export async function restoreInterruptedTask(store: Store, taskId: string) {
  const task = store.getTask(taskId);
  if (!task) return;
  let classification: { mutating?: boolean } | null = null;
  try {
    classification = task.classification ? JSON.parse(task.classification) as { mutating?: boolean } : null;
  } catch {
    /* Leave malformed historical metadata failed. */
  }
  const project = store.getProject(task.projectId);
  if (!classification?.mutating || !project) return;
  try {
    const status = await getGitStatus(project.root);
    const files = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (!status.isGit || !files.length) return;
    const message = 'The dashboard restarted during this task. Its uncommitted project changes were preserved and can continue through automatic repair and review.';
    store.updateTask(taskId, { state: 'recovery_required', error: message });
    store.addEvent(taskId, 'system', 'task.recovery-required', { message, files });
    store.addEvent(taskId, 'system', 'task.state', { state: 'recovery_required' });
  } catch {
    /* Preserve the ordinary interrupted failure if Git inspection fails. */
  }
}

export async function reconcileStartupTasks(store: Store): Promise<string[]> {
  // A live process cannot still own a worktree recorded by a previous process.
  // Dispatch refs remain active until their owning workflow reaches cleanup.
  // Jules review owners are random process-local ids.  Leaving one with its
  // two-hour TTL after a restart blocks the persisted workflow even though no
  // process can still satisfy its fencing token.
  store.manager.leases.releaseProcessLocalOwners('git_repository', 'jules-review-');
  store.manager.managedGitResources.scheduleOrphanedWorktreeCleanup();
  const recoveredTasks = store.recoverInterruptedTasks();
  const interruptedTasks = [...new Set([
    ...recoveredTasks,
    ...store.listTasks().filter((task) => task.state === 'failed' && /dashboard restarted while this task was running/i.test(task.error || '')).map((task) => task.id),
  ])];

  for (const taskId of interruptedTasks) {
    const task = store.getTask(taskId);
    const takeover = store.manager.checkpoints.latest(taskId, 'local_takeover');
    if (task?.target === 'local' && takeover && ['prepared', 'queued'].includes(String(takeover.data.status))) {
      const findings = Array.isArray(takeover.data.findings)
        ? takeover.data.findings.map((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).explanation === 'string'
          ? String((item as Record<string, unknown>).explanation) : '').filter(Boolean)
        : [];
      const message = task.error || `The dashboard restarted during a Jules local-repair takeover. The imported PR head is preserved and ready to resume.${findings.length ? ` Independent review findings: ${findings.join(' ')}` : ''}`;
      store.updateTask(taskId, { state: 'recovery_required', error: message });
      store.addEvent(taskId, 'system', 'task.recovery-required', { message, source: 'jules_local_takeover' });
      continue;
    }
    await restoreInterruptedTask(store, taskId);
  }

  // Repair the one safe, deterministic legacy failure produced by an older
  // state matrix: the local takeover had already imported the exact reviewed
  // head, but its recovery sensing transition was rejected before any local
  // mutation ran.  Other failed takeovers remain failed and require their
  // normal failure handling; this is not a blanket retry.
  for (const task of store.listTasks()) {
    const takeover = store.manager.checkpoints.latest(task.id, 'local_takeover');
    const transitionMismatch = task.state === 'failed' && /Illegal task state transition from 'recovering' to 'preflight'/i.test(task.error || '');
    if (task.target !== 'local' || !takeover || !['prepared', 'queued'].includes(String(takeover.data.status)) ||
        !(task.state === 'recovery_required' || transitionMismatch)) continue;
    if (transitionMismatch) {
      store.updateTask(task.id, { state: 'recovery_required', error: 'Resuming the prepared Jules local takeover after restoring the recovery preflight state transition.' });
      store.addEvent(task.id, 'system', 'task.recovery-required', { source: 'jules_takeover_state_recovery',
        message: 'The prepared Jules local takeover is being resumed through its normal preflight safety gate.' });
    }
  }

  // Older runs classified an exhausted Codex account as a terminal local
  // failure.  This exact, retryable provider condition is safe to repair on
  // restart: retain the original task identity and install the same durable
  // capacity checkpoint used by current runs.  Do not touch other failures.
  for (const task of store.listTasks()) {
    if (task.target !== 'local' || task.state !== 'failed' || !isCodexCapacityFailure(task.error || '')) continue;
    const existing = store.manager.checkpoints.latest(task.id, 'codex_capacity_retry');
    const prior = existing ? parseCodexCapacityRetry(existing.data) : null;
    const attempts = prior?.attempts ?? 0;
    const retryAt = new Date(Date.now() + codexCapacityRetryDelay(attempts)).toISOString();
    store.manager.transaction(() => {
      store.manager.checkpoints.append({ taskId: task.id, stage: 'codex_capacity_retry', data: {
        version: 1, attempts: attempts + 1, retryAt, reason: (task.error || '').slice(0, 2_000),
      } });
      store.updateTask(task.id, {
        state: 'recovery_required',
        error: `Codex capacity is unavailable; Orchestra will resume automatically after ${Math.ceil(codexCapacityRetryDelay(attempts) / 60_000)} minute(s).`,
      });
      store.addEvent(task.id, 'system', 'warning', {
        provider: 'codex', retryAt, attempts: attempts + 1, source: 'startup_capacity_recovery',
        message: 'Recovered a prior Codex capacity failure and scheduled the original local workflow to resume automatically.',
      });
    });
  }

  for (const intent of store.manager.commandIntents.listPending()) {
    if (intent.kind !== 'jules.dispatch' || !['pending', 'ambiguous'].includes(intent.state)) continue;
    const cloud = store.manager.cloudSessions.getByTaskId(intent.taskId);
    const task = store.getTask(intent.taskId);
    if (!cloud || !task) continue;
    const response = { ok: true, taskId: task.id, sessionId: task.sessionId, remoteSessionId: cloud.remoteSessionId, cloudSession: cloud };
    store.manager.transaction(() => {
      store.manager.commandIntents.transition(intent.id, intent.state, 'acknowledged', {
        attemptId: cloud.attemptId, providerResource: cloud.sessionResourceName, response,
      });
      store.manager.checkpoints.append({ taskId: task.id, attemptId: cloud.attemptId, stage: 'dispatch', subjectSha: cloud.baseSha,
        data: { status: 'startup_reconciled', remoteSessionId: cloud.remoteSessionId } });
    });
  }
  for (const cloud of store.manager.cloudSessions.listNonTerminal()) store.manager.activityCursors.ensure(cloud.id);
  store.manager.julesCapacity.releaseTerminalTasks();
  for (const task of store.listTasks().filter((item) => item.target === 'cloud' && !['completed', 'completed_unpushed', 'failed', 'cancelled', 'review_disputed'].includes(item.state))) {
    store.manager.julesCapacity.restore(task.id);
  }

  if (interruptedTasks.length) {
    console.warn(`Reconciled ${interruptedTasks.length} interrupted task(s) after restart.`);
  }

  return interruptedTasks;
}

/**
 * Only restart-marked, local, recoverable work is eligible for unattended
 * re-enqueue. User-paused/stopped work and imported Jules takeovers retain
 * their separate control paths.
 */
export function automaticInterruptedLocalRecoveryTaskIds(store: Store): string[] {
  return store.listTasks()
    .filter((task) => task.target === 'local' && task.state === 'recovery_required' && /dashboard restarted during this task/i.test(task.error || ''))
    .filter((task) => {
      if (store.manager.checkpoints.latest(task.id, 'pipeline_child')) return false;
      const takeover = store.manager.checkpoints.latest(task.id, 'local_takeover');
      return !(takeover && ['prepared', 'queued'].includes(String(takeover.data.status)));
    })
    .map((task) => task.id);
}
