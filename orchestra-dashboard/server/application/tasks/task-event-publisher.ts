import { EventEmitter } from 'node:events';
import type { Store } from '../../db.js';
import type { AgentName, TaskEvent, TaskEventType } from '../../domain/index.js';
import type { ProviderRunEventObserver } from '../usage/provider-run-recorder.js';

export class TaskEventPublisher {
  private readonly bus = new EventEmitter();
  constructor(private readonly store: Store, private readonly observeProviderRun?: ProviderRunEventObserver) { this.bus.setMaxListeners(100); }
  subscribe(taskId: string, listener: (event: TaskEvent) => void) {
    const name = `task:${taskId}`; this.bus.on(name, listener); return () => this.bus.off(name, listener);
  }
  publish(taskId: string, agent: AgentName, type: TaskEventType, payload: unknown): TaskEvent {
    const event = this.store.addEvent(taskId, agent, type, payload);
    try { this.observeProviderRun?.(event); } catch { /* Usage accounting must never block task progress. */ }
    this.bus.emit(`task:${taskId}`, event);
    return event;
  }
}
