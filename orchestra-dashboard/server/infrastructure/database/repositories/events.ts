import type { DatabaseSync } from 'node:sqlite';
import type { TaskEvent } from '../../../domain/index.js';
import { redactSecretsDeep } from '../../security/redaction.js';

function now() { return new Date().toISOString(); }

export class TaskEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  add(taskId: string, agent: string, type: string, payload: unknown): TaskEvent {
    const createdAt = now();
    const sanitizedPayload = redactSecretsDeep(payload);
    const result = this.db.prepare('INSERT INTO task_events (task_id,agent,type,payload,created_at) VALUES (?,?,?,?,?)')
      .run(taskId, agent, type, JSON.stringify(sanitizedPayload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      taskId,
      agent: agent as TaskEvent['agent'],
      type,
      payload: sanitizedPayload,
      createdAt,
    } as TaskEvent;
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
      } as TaskEvent;
    });
  }
}
