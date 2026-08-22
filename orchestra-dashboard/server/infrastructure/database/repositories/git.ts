import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

function now() { return new Date().toISOString(); }

export interface GitOperationRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  kind: string;
  sha: string | null;
  branch: string | null;
  pushStatus: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapGitOperation(row: unknown): GitOperationRecord {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    taskId: r.task_id ? String(r.task_id) : null,
    kind: String(r.kind),
    sha: r.sha ? String(r.sha) : null,
    branch: r.branch ? String(r.branch) : null,
    pushStatus: String(r.push_status),
    error: r.error ? String(r.error) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class GitOperationRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(
    projectId: string,
    taskId: string | null,
    kind: string,
    sha: string | null,
    branch: string | null,
    pushStatus: string,
    error: string | null
  ): string {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare(`
      INSERT INTO git_operations (
        id, project_id, task_id, kind, sha, branch, push_status, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, taskId, kind, sha, branch, pushStatus, error, stamp, stamp);
    return id;
  }

  listByProject(projectId: string): GitOperationRecord[] {
    return this.db.prepare('SELECT * FROM git_operations WHERE project_id=? ORDER BY created_at DESC LIMIT 50')
      .all(projectId)
      .map(mapGitOperation);
  }
}
