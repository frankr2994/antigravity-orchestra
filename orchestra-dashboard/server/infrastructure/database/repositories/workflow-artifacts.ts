import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ManagedGitResource, ManagedGitResourceKind, ManagedGitResourceState,
  OutboxState, WorkflowEvidence, WorkflowEvidenceKind, WorkflowOutboxItem,
} from '../../../domain/index.js';
import { encodeJsonRecord, nullableString, parseJsonRecord, requiredString } from './codec.js';

function now() { return new Date().toISOString(); }
function mapGitResource(row: unknown): ManagedGitResource {
  const value = row as Record<string, unknown>;
  return {
    id: requiredString(value.id, 'Git resource id'), taskId: requiredString(value.task_id, 'Git resource task'),
    attemptId: nullableString(value.attempt_id), repositoryRoot: requiredString(value.repository_root, 'repository root'),
    kind: requiredString(value.kind, 'Git resource kind') as ManagedGitResourceKind,
    resourceValue: requiredString(value.resource_value, 'Git resource value'),
    state: requiredString(value.state, 'Git resource state') as ManagedGitResourceState,
    cleanupAfter: nullableString(value.cleanup_after), lastErrorCode: nullableString(value.last_error_code),
    createdAt: requiredString(value.created_at, 'Git resource created time'), updatedAt: requiredString(value.updated_at, 'Git resource updated time'),
  };
}

export class ManagedGitResourceRepository {
  constructor(private readonly db: DatabaseSync) {}
  register(input: { taskId: string; attemptId?: string | null; repositoryRoot: string; kind: ManagedGitResourceKind; resourceValue: string }): ManagedGitResource {
    const existing = this.db.prepare('SELECT * FROM managed_git_resources WHERE repository_root=? AND kind=? AND resource_value=?')
      .get(input.repositoryRoot, input.kind, input.resourceValue);
    if (existing) {
      const mapped = mapGitResource(existing);
      if (mapped.taskId !== input.taskId || mapped.attemptId !== (input.attemptId ?? null)) {
        throw new Error('Managed Git resource is already owned by another task or attempt');
      }
      return mapped;
    }
    const id = randomUUID(); const stamp = now();
    this.db.prepare(`INSERT INTO managed_git_resources
      (id,task_id,attempt_id,repository_root,kind,resource_value,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'active',?,?)`).run(id, input.taskId, input.attemptId ?? null,
        input.repositoryRoot, input.kind, input.resourceValue, stamp, stamp);
    return this.getById(id)!;
  }
  getById(id: string): ManagedGitResource | null {
    const row = this.db.prepare('SELECT * FROM managed_git_resources WHERE id=?').get(id);
    return row ? mapGitResource(row) : null;
  }
  scheduleCleanup(id: string, cleanupAfter = now()): ManagedGitResource {
    this.db.prepare("UPDATE managed_git_resources SET state='cleanup_pending',cleanup_after=?,updated_at=? WHERE id=? AND state!='cleaned'")
      .run(cleanupAfter, now(), id);
    return this.getById(id)!;
  }
  listCleanupDue(at = now(), limit = 100): ManagedGitResource[] {
    return this.db.prepare("SELECT * FROM managed_git_resources WHERE state IN ('cleanup_pending','cleanup_failed') AND cleanup_after<=? ORDER BY cleanup_after LIMIT ?")
      .all(at, limit).map(mapGitResource);
  }
  completeCleanup(id: string, ok: boolean, errorCode?: string | null): ManagedGitResource {
    this.db.prepare('UPDATE managed_git_resources SET state=?,last_error_code=?,updated_at=? WHERE id=?')
      .run(ok ? 'cleaned' : 'cleanup_failed', errorCode ?? null, now(), id);
    return this.getById(id)!;
  }
}

function mapEvidence(row: unknown): WorkflowEvidence {
  const value = row as Record<string, unknown>;
  return {
    id: requiredString(value.id, 'evidence id'), taskId: requiredString(value.task_id, 'evidence task'),
    attemptId: nullableString(value.attempt_id), kind: requiredString(value.kind, 'evidence kind') as WorkflowEvidenceKind,
    subjectSha: nullableString(value.subject_sha), outcome: requiredString(value.outcome, 'evidence outcome'),
    payload: parseJsonRecord(value.payload_json, 'workflow evidence'), createdAt: requiredString(value.created_at, 'evidence time'),
  };
}
export class WorkflowEvidenceRepository {
  constructor(private readonly db: DatabaseSync) {}
  record(input: { taskId: string; attemptId?: string | null; kind: WorkflowEvidenceKind; subjectSha?: string | null; outcome: string; payload: Record<string, unknown> }): WorkflowEvidence {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO workflow_evidence (id,task_id,attempt_id,kind,subject_sha,outcome,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, input.taskId, input.attemptId ?? null, input.kind,
        input.subjectSha ?? null, input.outcome, encodeJsonRecord(input.payload, 'workflow evidence'), now());
    return this.getById(id)!;
  }
  getById(id: string): WorkflowEvidence | null {
    const row = this.db.prepare('SELECT * FROM workflow_evidence WHERE id=?').get(id);
    return row ? mapEvidence(row) : null;
  }
  list(taskId: string, kind?: WorkflowEvidenceKind): WorkflowEvidence[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM workflow_evidence WHERE task_id=? AND kind=? ORDER BY created_at').all(taskId, kind)
      : this.db.prepare('SELECT * FROM workflow_evidence WHERE task_id=? ORDER BY created_at').all(taskId);
    return rows.map(mapEvidence);
  }
}

function mapOutbox(row: unknown): WorkflowOutboxItem {
  const value = row as Record<string, unknown>;
  return {
    id: requiredString(value.id, 'outbox id'), taskId: requiredString(value.task_id, 'outbox task'),
    topic: requiredString(value.topic, 'outbox topic'), payload: parseJsonRecord(value.payload_json, 'outbox payload'),
    state: requiredString(value.state, 'outbox state') as OutboxState, attempts: Number(value.attempts),
    availableAt: requiredString(value.available_at, 'outbox availability'), publishedAt: nullableString(value.published_at),
    lastErrorCode: nullableString(value.last_error_code), createdAt: requiredString(value.created_at, 'outbox created time'),
    updatedAt: requiredString(value.updated_at, 'outbox updated time'),
  };
}
export class WorkflowOutboxRepository {
  constructor(private readonly db: DatabaseSync) {}
  enqueue(taskId: string, topic: string, payload: Record<string, unknown>, availableAt = now()): WorkflowOutboxItem {
    const id = randomUUID(); const stamp = now();
    this.db.prepare(`INSERT INTO workflow_outbox
      (id,task_id,topic,payload_json,state,available_at,created_at,updated_at)
      VALUES (?,?,?,?,'pending',?,?,?)`).run(id, taskId, topic, encodeJsonRecord(payload, 'outbox payload'), availableAt, stamp, stamp);
    return this.getById(id)!;
  }
  getById(id: string): WorkflowOutboxItem | null {
    const row = this.db.prepare('SELECT * FROM workflow_outbox WHERE id=?').get(id);
    return row ? mapOutbox(row) : null;
  }
  claimDue(at = now(), limit = 100): WorkflowOutboxItem[] {
    const due = this.db.prepare("SELECT id FROM workflow_outbox WHERE state IN ('pending','failed') AND available_at<=? ORDER BY available_at LIMIT ?")
      .all(at, limit) as Array<{ id: string }>;
    if (!due.length) return [];
    const update = this.db.prepare("UPDATE workflow_outbox SET state='publishing',attempts=attempts+1,updated_at=? WHERE id=? AND state IN ('pending','failed')");
    const claimed: WorkflowOutboxItem[] = [];
    for (const item of due) {
      if (Number(update.run(now(), item.id).changes) === 1) claimed.push(this.getById(item.id)!);
    }
    return claimed;
  }
  finish(id: string, published: boolean, fields: { nextAttemptAt?: string; errorCode?: string | null } = {}): WorkflowOutboxItem {
    this.db.prepare(`UPDATE workflow_outbox SET state=?,available_at=?,published_at=?,last_error_code=?,updated_at=?
      WHERE id=? AND state='publishing'`).run(published ? 'published' : 'failed', fields.nextAttemptAt ?? now(),
        published ? now() : null, fields.errorCode ?? null, now(), id);
    return this.getById(id)!;
  }
}
