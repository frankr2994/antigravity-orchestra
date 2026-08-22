import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ExecutionAttempt, WorkerIdentity, ExecutionTarget, ProviderExecutionState } from '../../../domain/index.js';

function now() { return new Date().toISOString(); }

function mapAttempt(row: unknown): ExecutionAttempt {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    target: String(r.target) as ExecutionTarget,
    worker: String(r.worker) as WorkerIdentity,
    providerSessionId: r.provider_session_id ? String(r.provider_session_id) : null,
    baseSha: String(r.base_sha),
    headSha: r.head_sha ? String(r.head_sha) : null,
    branchName: r.branch_name ? String(r.branch_name) : null,
    prUrl: r.pr_url ? String(r.pr_url) : null,
    state: String(r.state) as ProviderExecutionState,
    retryCount: Number(r.retry_count || 0),
    error: r.error ? String(r.error) : null,
    startedAt: String(r.started_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
  };
}

export class ExecutionAttemptRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    taskId: string;
    target: ExecutionTarget;
    worker: WorkerIdentity;
    baseSha: string;
    providerSessionId?: string | null;
    branchName?: string | null;
    state?: ProviderExecutionState;
  }): ExecutionAttempt {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare(`
      INSERT INTO execution_attempts (
        id, task_id, target, worker, provider_session_id, base_sha,
        branch_name, state, retry_count, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id,
      input.taskId,
      input.target,
      input.worker,
      input.providerSessionId ?? null,
      input.baseSha,
      input.branchName ?? null,
      input.state ?? 'WORKING',
      stamp
    );
    return this.getById(id)!;
  }

  getById(id: string): ExecutionAttempt | null {
    const row = this.db.prepare('SELECT * FROM execution_attempts WHERE id=?').get(id);
    return row ? mapAttempt(row) : null;
  }

  listByTask(taskId: string): ExecutionAttempt[] {
    return this.db.prepare('SELECT * FROM execution_attempts WHERE task_id=? ORDER BY started_at DESC').all(taskId).map(mapAttempt);
  }

  update(id: string, fields: Partial<Pick<ExecutionAttempt, 'state' | 'headSha' | 'prUrl' | 'retryCount' | 'error' | 'completedAt'>>) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const names: Record<string, string> = {
      headSha: 'head_sha',
      prUrl: 'pr_url',
      retryCount: 'retry_count',
      completedAt: 'completed_at',
    };
    const assignments = entries.map(([key]) => `${names[key] || key}=?`).join(',');
    this.db.prepare(`UPDATE execution_attempts SET ${assignments} WHERE id=?`)
      .run(...entries.map(([, value]) => value), id);
  }
}
