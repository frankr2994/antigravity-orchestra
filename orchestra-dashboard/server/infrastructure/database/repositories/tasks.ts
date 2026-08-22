import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  type TaskRecord,
  type OrchestraTaskState,
  type ExecutionTarget,
  isOrchestraTaskState,
  isValidTaskStateTransition,
} from '../../../domain/index.js';

function now() { return new Date().toISOString(); }

function mapTask(row: unknown): TaskRecord {
  const r = row as Record<string, unknown>;
  const rawState = String(r.state);
  const state: OrchestraTaskState = isOrchestraTaskState(rawState) ? rawState : 'failed';

  return {
    id: String(r.id),
    projectId: String(r.project_id),
    sessionId: String(r.session_id),
    prompt: String(r.prompt),
    title: String(r.title),
    state,
    target: (r.target ? String(r.target) : 'local') as ExecutionTarget,
    classification: r.classification ? String(r.classification) : null,
    models: r.models ? String(r.models) : null,
    result: r.result ? String(r.result) : null,
    error: r.error ? String(r.error) : null,
    commitSha: r.commit_sha ? String(r.commit_sha) : null,
    pushStatus: r.push_status ? String(r.push_status) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(
    projectId: string,
    sessionId: string,
    prompt: string,
    classification: string | null = null,
    models: string | null = null,
    target: ExecutionTarget = 'local'
  ): TaskRecord {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare(`INSERT INTO tasks
      (id,project_id,session_id,prompt,title,state,target,classification,models,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, projectId, sessionId, prompt, prompt.slice(0, 72), 'queued', target, classification, models, stamp, stamp);
    return this.getById(id)!;
  }

  getById(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return row ? mapTask(row) : null;
  }

  list(projectId?: string): TaskRecord[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').all();
    return rows.map(mapTask);
  }

  update(
    id: string,
    fields: Partial<Pick<TaskRecord, 'state' | 'title' | 'target' | 'classification' | 'models' | 'result' | 'error' | 'commitSha' | 'pushStatus'>>
  ) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;

    if (fields.state !== undefined) {
      if (!isOrchestraTaskState(fields.state)) {
        throw new Error(`Invalid task state: '${fields.state}'`);
      }
      const current = this.getById(id);
      if (current && !isValidTaskStateTransition(current.state, fields.state)) {
        throw new Error(`Illegal task state transition from '${current.state}' to '${fields.state}' for task ${id}`);
      }
    }

    const names: Record<string, string> = { commitSha: 'commit_sha', pushStatus: 'push_status' };
    const assignments = entries.map(([key]) => `${names[key] || key}=?`).join(',');
    this.db.prepare(`UPDATE tasks SET ${assignments},updated_at=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), now(), id);
  }

  recoverInterruptedTasks(): string[] {
    const terminal = ['completed', 'completed_unpushed', 'failed', 'cancelled', 'baseline_required', 'recovery_required'];
    const placeholders = terminal.map(() => '?').join(',');
    const stamp = now();
    const rows = this.db.prepare(`SELECT id FROM tasks WHERE state NOT IN (${placeholders})`).all(...terminal) as Array<{ id: string }>;
    if (rows.length) {
      this.db.prepare(
        `UPDATE tasks SET state='failed',error='The dashboard restarted while this task was running. Submit it again to retry safely.',updated_at=? WHERE state NOT IN (${placeholders})`
      ).run(stamp, ...terminal);
    }
    return rows.map((row) => row.id);
  }
}
