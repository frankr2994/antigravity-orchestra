/** Minimal application port for dispatching an already-persisted local task. */
export interface LocalTaskQueue {
  enqueue(taskId: string): void;
}
