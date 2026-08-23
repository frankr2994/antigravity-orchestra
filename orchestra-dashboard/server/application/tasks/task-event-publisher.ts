import { EventEmitter } from 'node:events';
import type { Store } from '../../db.js';
import type { AgentName, TaskEvent, TaskEventType } from '../../domain/index.js';

export class TaskEventPublisher {
  private readonly bus = new EventEmitter();
  constructor(private readonly store: Store) { this.bus.setMaxListeners(100); }
  subscribe(taskId: string, listener: (event: TaskEvent) => void) {
    const name = `task:${taskId}`; this.bus.on(name, listener); return () => this.bus.off(name, listener);
  }
  publish(taskId: string, agent: AgentName, type: TaskEventType, payload: unknown): TaskEvent {
    const event = this.store.addEvent(taskId, agent, type, payload);
    this.bus.emit(`task:${taskId}`, event);
    return event;
  }
}
