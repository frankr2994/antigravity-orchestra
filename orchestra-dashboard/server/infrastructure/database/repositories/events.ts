import type { DatabaseSync } from 'node:sqlite';
import { parseTaskEvent, type TaskEvent } from '../../../domain/index.js';
import { redactSecretsDeep } from '../../security/redaction.js';

function now() { return new Date().toISOString(); }

export class TaskEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  add(taskId: string, agent: string, type: string, payload: unknown): TaskEvent {
    const createdAt = now();
    const sanitizedPayload = redactSecretsDeep(payload);
    const validated = parseTaskEvent({ id: 0, taskId, agent, type, payload: sanitizedPayload, createdAt });
    const result = this.db.prepare('INSERT INTO task_events (task_id,agent,type,payload,created_at) VALUES (?,?,?,?,?)')
      .run(taskId, validated.agent, validated.type, JSON.stringify(validated.payload), createdAt);
    return { ...validated, id: Number(result.lastInsertRowid) };
  }

  list(taskId: string, after = 0): TaskEvent[] {
    return this.db.prepare('SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id').all(taskId, after).map((row) => {
      const value = row as Record<string, unknown>;
      let payload: unknown;
      try {
        payload = JSON.parse(String(value.payload));
      } catch {
        throw new Error(`Stored task event ${String(value.id)} contains invalid JSON.`);
      }
      return parseTaskEvent({
        id: Number(value.id),
        taskId: String(value.task_id),
        agent: String(value.agent),
        type: String(value.type),
        payload: redactSecretsDeep(payload),
        createdAt: String(value.created_at),
      });
    });
  }
}
