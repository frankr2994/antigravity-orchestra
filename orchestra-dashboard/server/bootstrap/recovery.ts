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
  const recoveredTasks = store.recoverInterruptedTasks();
  const interruptedTasks = [...new Set([
    ...recoveredTasks,
    ...store.listTasks().filter((task) => task.state === 'failed' && /dashboard restarted while this task was running/i.test(task.error || '')).map((task) => task.id),
  ])];

  for (const taskId of interruptedTasks) {
    await restoreInterruptedTask(store, taskId);
  }

  if (interruptedTasks.length) {
    console.warn(`Reconciled ${interruptedTasks.length} interrupted task(s) after restart.`);
  }

  return interruptedTasks;
}
