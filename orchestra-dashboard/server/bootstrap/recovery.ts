import type { Store } from '../db.js';
import { getGitStatus } from '../git.js';
import { isOrchestraInternalPath } from '../projects.js';

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
