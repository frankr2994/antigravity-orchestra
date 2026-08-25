import type { Store } from '../../db.js';
import type { TaskEventType, TaskRecord } from '../../domain/index.js';
import { getGitStatus, type GitStatus } from '../../git.js';
import { isOrchestraInternalPath } from '../../projects.js';
import type { ProjectTaskScheduler } from './project-task-scheduler.js';

type Emit = (taskId: string, type: TaskEventType, payload: unknown) => void;
type StatusReader = (root: string) => Promise<GitStatus>;

const cleanReleasableStates = new Set<TaskRecord['state']>([
  'baseline_required',
  'recovery_required',
  'review_disputed',
]);

/** Resolves durable project ownership separately from queue/process scheduling. */
export class ProjectTaskOwnershipService {
  constructor(
    private readonly store: Store,
    private readonly scheduler: ProjectTaskScheduler,
    private readonly emit: Emit,
    private readonly readStatus: StatusReader = getGitStatus,
  ) {}

  current(projectId: string): TaskRecord | null {
    const taskId = this.scheduler.activeTaskId(projectId);
    return taskId ? this.store.getTask(taskId) : null;
  }

  async reconcile(projectId: string): Promise<TaskRecord | null> {
    const task = this.current(projectId);
    if (!task || task.target === 'cloud' || this.scheduler.isRunning(task.id) || !cleanReleasableStates.has(task.state)) return task;
    const project = this.store.getProject(projectId);
    if (!project) return task;

    let status: GitStatus;
    try {
      status = await this.readStatus(project.root);
    } catch {
      return task;
    }
    if (!status.isGit || status.files.some((file) => !isOrchestraInternalPath(file.path))) return task;

    // Git inspection yields to the event loop. Prove that this exact task still owns the
    // project before releasing it so concurrent submissions cannot both pass the stale check.
    const current = this.current(projectId);
    if (!current || current.id !== task.id) return current;
    if (this.scheduler.isRunning(current.id) || !cleanReleasableStates.has(current.state)) return current;

    const previousState = current.state;
    const message = `Released stale ${previousState.replaceAll('_', ' ')} ownership because the project has no uncommitted changes and no task process is running.`;
    this.store.updateTask(current.id, { state: 'cancelled', error: message });
    for (const attempt of this.store.manager.attempts.listByTaskId(current.id)) {
      if (attempt.target === 'local' && attempt.state === 'WORKING') {
        this.store.manager.attempts.update(attempt.id, { state: 'CANCELLED', completedAt: new Date().toISOString() });
      }
    }
    this.emit(current.id, 'task.state', { state: 'cancelled', message, previousState, ownershipReleased: true });
    return null;
  }
}
