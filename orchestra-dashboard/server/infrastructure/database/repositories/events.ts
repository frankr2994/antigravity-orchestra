import type { DatabaseSync } from 'node:sqlite';
import type { TaskEvent } from '../../../domain/index.js';

function now() { return new Date().toISOString(); }

export class TaskEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  add(taskId: string, agent: string, type: string, payload: unknown): TaskEvent {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO task_events (task_id,agent,type,payload,created_at) VALUES (?,?,?,?,?)')
      .run(taskId, agent, type, JSON.stringify(payload), createdAt);
    return { id: Number(result.lastInsertRowid), taskId, agent: agent as TaskEvent['agent'], type, payload, createdAt };
  }

  list(taskId: string, after = 0): TaskEvent[] {
    return this.db.prepare('SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id').all(taskId, after).map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: Number(value.id),
        taskId: String(value.task_id),
        agent: String(value.agent) as TaskEvent['agent'],
        type: String(value.type),
        payload: JSON.parse(String(value.payload)),
        createdAt: String(value.created_at),
      };
    });
  }
}
