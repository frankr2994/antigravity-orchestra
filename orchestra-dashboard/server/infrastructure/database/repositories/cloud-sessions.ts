import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CloudSessionReference } from '../../../domain/index.js';

function now() { return new Date().toISOString(); }

function mapCloudSession(row: unknown): CloudSessionReference {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    taskId: String(r.task_id),
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
        id, task_id, provider_id, source_name, session_resource_name,
        remote_session_id, dispatch_branch, target_branch, base_sha,
        state, created_at, updated_at
      ) VALUES (?, ?, 'jules', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.taskId,
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
