import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CloudSessionReference } from '../../../domain/index.js';

export interface ProjectCloudSessionActivity {
  cloudSessionId: string;
  taskId: string;
  title: string;
  providerState: string;
  workflowPhase: string;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

function now() { return new Date().toISOString(); }

function mapCloudSession(row: unknown): CloudSessionReference {
  const r = row as Record<string, unknown>;
  if (r.provider_id !== 'jules') throw new TypeError(`Persisted cloud session contains invalid provider '${String(r.provider_id)}'`);
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    attemptId: r.attempt_id ? String(r.attempt_id) : null,
    providerId: 'jules',
    sourceName: String(r.source_name),
    sessionResourceName: String(r.session_resource_name),
    remoteSessionId: String(r.remote_session_id),
    dispatchBranch: String(r.dispatch_branch),
    targetBranch: String(r.target_branch),
    baseSha: String(r.base_sha),
    prHeadSha: r.pr_head_sha ? String(r.pr_head_sha) : null,
    prUrl: r.pr_url ? String(r.pr_url) : null,
    state: String(r.state),
    lastActivityId: r.last_activity_id ? String(r.last_activity_id) : null,
    lastActivityAt: r.last_activity_at ? String(r.last_activity_at) : null,
    pollingLeaseExpiresAt: r.polling_lease_expires_at ? String(r.polling_lease_expires_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class CloudSessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    taskId: string;
    attemptId?: string | null;
    sourceName: string;
    sessionResourceName: string;
    remoteSessionId: string;
    dispatchBranch: string;
    targetBranch: string;
    baseSha: string;
    state?: string;
  }): CloudSessionReference {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare(`
      INSERT INTO cloud_sessions (
        id, task_id, attempt_id, provider_id, source_name, session_resource_name,
        remote_session_id, dispatch_branch, target_branch, base_sha,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, 'jules', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.taskId,
      input.attemptId ?? null,
      input.sourceName,
      input.sessionResourceName,
      input.remoteSessionId,
      input.dispatchBranch,
      input.targetBranch,
      input.baseSha,
      input.state ?? 'QUEUED',
      stamp,
      stamp
    );
    return this.getById(id)!;
  }

  getById(id: string): CloudSessionReference | null {
    const row = this.db.prepare('SELECT * FROM cloud_sessions WHERE id=?').get(id);
    return row ? mapCloudSession(row) : null;
  }

  getByTaskId(taskId: string): CloudSessionReference | null {
    const row = this.db.prepare('SELECT * FROM cloud_sessions WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(taskId);
    return row ? mapCloudSession(row) : null;
  }

  getByRemoteSessionId(remoteSessionId: string): CloudSessionReference | null {
    const row = this.db.prepare('SELECT * FROM cloud_sessions WHERE remote_session_id=?').get(remoteSessionId);
    return row ? mapCloudSession(row) : null;
  }

  listNonTerminal(): CloudSessionReference[] {
    const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED'];
    const placeholders = terminalStates.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM cloud_sessions WHERE state NOT IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...terminalStates)
      .map(mapCloudSession);
  }

  listProjectActivitySince(projectId: string, cutoff: string): ProjectCloudSessionActivity[] {
    const rows = this.db.prepare(`
      SELECT cs.id AS cloud_session_id, cs.task_id, t.title, cs.state AS provider_state,
             t.state AS workflow_phase, cs.pr_url, cs.created_at, cs.updated_at
      FROM cloud_sessions cs
      INNER JOIN tasks t ON t.id = cs.task_id
      WHERE t.project_id = ? AND cs.created_at > ?
      ORDER BY cs.updated_at DESC, cs.id ASC
    `).all(projectId, cutoff) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      cloudSessionId: String(row.cloud_session_id),
      taskId: String(row.task_id),
      title: String(row.title),
      providerState: String(row.provider_state),
      workflowPhase: String(row.workflow_phase),
      prUrl: row.pr_url ? String(row.pr_url) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  acquirePollingLease(id: string, leaseDurationMs = 30_000): boolean {
    const stamp = now();
    const expiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
    const result = this.db.prepare(`
      UPDATE cloud_sessions
      SET polling_lease_expires_at = ?, updated_at = ?
      WHERE id = ?
        AND (polling_lease_expires_at IS NULL OR polling_lease_expires_at < ?)
    `).run(expiresAt, stamp, id, stamp);
    return Number(result.changes || 0) > 0;
  }

  releasePollingLease(id: string) {
    const stamp = now();
    this.db.prepare('UPDATE cloud_sessions SET polling_lease_expires_at = NULL, updated_at = ? WHERE id = ?')
      .run(stamp, id);
  }

  update(
    id: string,
    fields: Partial<Pick<CloudSessionReference, 'state' | 'prHeadSha' | 'prUrl' | 'lastActivityId' | 'lastActivityAt' | 'pollingLeaseExpiresAt'>>
  ) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const names: Record<string, string> = {
      prHeadSha: 'pr_head_sha',
      prUrl: 'pr_url',
      lastActivityId: 'last_activity_id',
      lastActivityAt: 'last_activity_at',
      pollingLeaseExpiresAt: 'polling_lease_expires_at',
    };
    const assignments = entries.map(([key]) => `${names[key] || key}=?`).join(',');
    this.db.prepare(`UPDATE cloud_sessions SET ${assignments},updated_at=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), now(), id);
  }
}
