import type { Store } from '../../db.js';
import { getGitStatus } from '../../git.js';
import { isOrchestraInternalPath } from '../../projects.js';
import type { AgentName, TaskRecord } from '../../types.js';
import type { TaskEventType } from '../../domain/index.js';
import { ApplicationError } from '../errors.js';
import type { ProjectTaskScheduler } from './project-task-scheduler.js';

type ControlRequest = 'pause' | 'stop';
type Publish = (taskId: string, agent: AgentName, type: TaskEventType, payload: unknown) => void;
type ReadGitStatus = typeof getGitStatus;

export class TaskControlService {
  constructor(
    private readonly store: Store,
    private readonly scheduler: ProjectTaskScheduler,
    private readonly controlRequests: Map<string, ControlRequest>,
    private readonly publish: Publish,
    private readonly readGitStatus: ReadGitStatus = getGitStatus,
  ) {}

  async pause(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.target === 'cloud') {
      throw new ApplicationError('JULES_REMOTE_PAUSE_UNAVAILABLE', 'The public Jules API does not expose a pause operation.', 409,
        { nextAction: 'Pause the session in Jules; Orchestra will detect the PAUSED state automatically.', retryable: false });
    }
    if (task.state === 'paused') return task;
    if (!['queued', 'preflight', 'routing', 'running', 'recovering', 'reviewing', 'verifying'].includes(task.state)) {
      throw new ApplicationError('TASK_NOT_PAUSABLE', `Task is ${task.state.replaceAll('_', ' ')} and cannot be paused.`, 409,
        { nextAction: task.state === 'recovery_required' ? 'Use Resume to continue the preserved changes.' : 'Refresh the task and use the action offered for its current state.', retryable: false });
    }
    this.scheduler.remove(taskId);
    if (this.scheduler.isRunning(taskId)) {
      this.controlRequests.set(taskId, 'pause');
      try { await this.scheduler.abortAndWait(taskId, 'pause'); }
      finally { this.controlRequests.delete(taskId); }
    }
    const latest = requireTask(this.store, taskId);
    if (['completed', 'completed_unpushed', 'failed', 'cancelled', 'recovery_required', 'review_disputed'].includes(latest.state)) return latest;
    const message = 'Paused by the user after the active local process stopped. Resume continues this same task with its preserved project state.';
    this.store.updateTask(taskId, { state: 'paused', error: message });
    this.publish(taskId, 'system', 'task.paused', { message, nextAction: 'Select Resume to continue this task.' });
    this.publish(taskId, 'system', 'task.state', { state: 'paused', message });
    return requireTask(this.store, taskId);
  }

  async resume(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.state !== 'paused') throw new ApplicationError('TASK_NOT_PAUSED', `Task is ${task.state.replaceAll('_', ' ')} and cannot be resumed with this action.`, 409,
      { nextAction: task.state === 'recovery_required' ? 'Use Resume and review to continue preserved changes.' : 'Refresh the task and use the action offered for its current state.', retryable: false });
    this.store.updateTask(taskId, { state: 'recovering' });
    this.publish(taskId, 'system', 'task.resumed', { message: 'Resuming the same task with its preserved local project state.' });
    this.publish(taskId, 'system', 'task.state', { state: 'recovering' });
    this.scheduler.enqueue(taskId);
    return requireTask(this.store, taskId);
  }

  async stop(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.target === 'cloud') {
      throw new ApplicationError('JULES_REMOTE_STOP_REQUIRED', 'Cloud tasks must be stopped through the Jules session control so the remote worker is confirmed deleted.', 409,
        { nextAction: 'Use Stop Jules in the cloud-session panel.', retryable: false });
    }
    if (['completed', 'completed_unpushed', 'failed', 'cancelled'].includes(task.state)) return task;
    this.scheduler.remove(taskId);
    if (this.scheduler.isRunning(taskId)) {
      this.controlRequests.set(taskId, 'stop');
      try { await this.scheduler.abortAndWait(taskId, 'stop'); }
      finally { this.controlRequests.delete(taskId); }
    }
    const latest = requireTask(this.store, taskId);
    if (['completed', 'completed_unpushed', 'failed', 'cancelled'].includes(latest.state)) return latest;
    const project = this.store.getProject(latest.projectId);
    if (!project) throw new Error('Project not found.');
    let preservedFiles: Array<{ path: string }> = [];
    try { preservedFiles = (await this.readGitStatus(project.root)).files.filter((file) => !isOrchestraInternalPath(file.path)); } catch { /* A stop can still finish safely without Git details. */ }
    if (preservedFiles.length) {
      const message = `Stopped by the user after the active process exited. ${preservedFiles.length} changed project file${preservedFiles.length === 1 ? ' was' : 's were'} preserved; resume this task to review and finish them.`;
      this.store.updateTask(taskId, { state: 'recovery_required', error: message });
      this.publish(taskId, 'system', 'task.recovery-required', { message, files: preservedFiles, nextAction: 'Select Resume to continue, or handle the preserved files explicitly.' });
      this.publish(taskId, 'system', 'task.state', { state: 'recovery_required', message });
    } else {
      this.store.updateTask(taskId, { state: 'cancelled', error: 'Stopped by the user after the active process exited.' });
      for (const attempt of this.store.manager.attempts.listByTaskId(taskId)) {
        if (attempt.target === 'local' && attempt.state === 'WORKING') this.store.manager.attempts.update(attempt.id, { state: 'CANCELLED', completedAt: new Date().toISOString() });
      }
      this.publish(taskId, 'system', 'task.state', { state: 'cancelled' });
    }
    return requireTask(this.store, taskId);
  }
}

function requireTask(store: Store, taskId: string) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found.');
  return task;
}
