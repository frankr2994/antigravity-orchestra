import type { Store } from '../../db.js';

export type TaskExecutor = (taskId: string, signal: AbortSignal) => Promise<void>;

/** Owns in-process concurrency and one-mutating-task-per-project scheduling. */
export class ProjectTaskScheduler {
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly runningProjects = new Set<string>();

  constructor(private readonly store: Store, private readonly executor: TaskExecutor, private readonly maxGlobal = 2) {
    if (!Number.isSafeInteger(maxGlobal) || maxGlobal < 1) throw new TypeError('maxGlobal must be a positive integer');
  }
  enqueue(taskId: string) {
    if (!this.queue.includes(taskId) && !this.controllers.has(taskId)) this.queue.push(taskId);
    this.drain();
  }
  enqueueAfterCurrent(taskId: string) {
    if (!this.queue.includes(taskId)) this.queue.push(taskId);
    this.drain();
  }
  remove(taskId: string) {
    const index = this.queue.indexOf(taskId);
    if (index >= 0) this.queue.splice(index, 1);
  }
  abort(taskId: string, reason: 'pause' | 'stop' = 'stop') { this.controllers.get(taskId)?.abort(reason); }
  async abortAndWait(taskId: string, reason: 'pause' | 'stop'): Promise<void> {
    this.abort(taskId, reason);
    await this.runs.get(taskId)?.catch(() => undefined);
  }
  isRunning(taskId: string) { return this.controllers.has(taskId); }
  activeTaskId(projectId: string): string | null {
    for (const [taskId] of this.controllers) if (this.store.getTask(taskId)?.projectId === projectId) return taskId;
    const queued = this.queue.map((taskId) => this.store.getTask(taskId)).find((task) => task?.projectId === projectId)?.id;
    if (queued) return queued;
    return this.store.listTasks(projectId).find((task) => !['completed', 'completed_unpushed', 'failed', 'cancelled'].includes(task.state))?.id ?? null;
  }
  private drain() {
    while (this.controllers.size < this.maxGlobal) {
      const index = this.queue.findIndex((id) => {
        const task = this.store.getTask(id);
        return task && !this.runningProjects.has(task.projectId);
      });
      if (index < 0) return;
      const [taskId] = this.queue.splice(index, 1);
      const task = this.store.getTask(taskId);
      if (!task || !['queued', 'recovering'].includes(task.state)) continue;
      const controller = new AbortController();
      this.controllers.set(taskId, controller); this.runningProjects.add(task.projectId);
      const run = this.executor(taskId, controller.signal).finally(() => {
        this.controllers.delete(taskId); this.runningProjects.delete(task.projectId); this.drain();
      });
      this.runs.set(taskId, run);
      void run.then(() => this.runs.delete(taskId), () => this.runs.delete(taskId));
    }
  }
}
