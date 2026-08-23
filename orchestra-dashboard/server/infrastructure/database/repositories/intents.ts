import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CommandIntent, CommandIntentState, WorkflowCheckpoint } from '../../../domain/index.js';
import { encodeJsonRecord, nullableString, parseJsonRecord, requiredString } from './codec.js';

function now() { return new Date().toISOString(); }
function mapIntent(row: unknown): CommandIntent {
  const value = row as Record<string, unknown>;
  const state = requiredString(value.state, 'command intent state');
  if (!['pending', 'acknowledged', 'ambiguous', 'failed'].includes(state)) throw new TypeError(`Invalid command intent state '${state}'`);
  return {
    id: requiredString(value.id, 'command intent id'),
    taskId: requiredString(value.task_id, 'command intent task'),
    attemptId: nullableString(value.attempt_id),
    kind: requiredString(value.kind, 'command intent kind'),
    idempotencyKey: requiredString(value.idempotency_key, 'command intent idempotency key'),
    requestHash: requiredString(value.request_hash, 'command intent request hash'),
    state: state as CommandIntentState,
    providerResource: nullableString(value.provider_resource),
    response: value.response_json === null ? null : parseJsonRecord(value.response_json, 'command intent response'),
    errorCode: nullableString(value.error_code),
    createdAt: requiredString(value.created_at, 'command intent created time'),
    updatedAt: requiredString(value.updated_at, 'command intent updated time'),
  };
}

export class CommandIntentRepository {
  constructor(private readonly db: DatabaseSync) {}

  static requestHash(request: Record<string, unknown>): string {
    return createHash('sha256').update(encodeJsonRecord(request, 'command request')).digest('hex');
  }

  createOrGet(input: {
    taskId: string; attemptId?: string | null; kind: string; idempotencyKey: string; requestHash: string;
  }): { intent: CommandIntent; created: boolean } {
    const existing = this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.taskId !== input.taskId || existing.kind !== input.kind || existing.requestHash !== input.requestHash) {
        throw new Error('Idempotency key was reused for a different command');
      }
      return { intent: existing, created: false };
    }
    const id = randomUUID(); const stamp = now();
    this.db.prepare(`INSERT INTO command_intents
      (id,task_id,attempt_id,kind,idempotency_key,request_hash,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending',?,?)`)
      .run(id, input.taskId, input.attemptId ?? null, input.kind, input.idempotencyKey, input.requestHash, stamp, stamp);
    return { intent: this.getById(id)!, created: true };
  }

  getById(id: string): CommandIntent | null {
    const row = this.db.prepare('SELECT * FROM command_intents WHERE id=?').get(id);
    return row ? mapIntent(row) : null;
  }
  getByIdempotencyKey(key: string): CommandIntent | null {
    const row = this.db.prepare('SELECT * FROM command_intents WHERE idempotency_key=?').get(key);
    return row ? mapIntent(row) : null;
  }
  listPending(): CommandIntent[] {
    return this.db.prepare("SELECT * FROM command_intents WHERE state IN ('pending','ambiguous') ORDER BY created_at").all().map(mapIntent);
  }
  transition(id: string, expected: CommandIntentState, next: CommandIntentState, fields: {
    attemptId?: string | null; providerResource?: string | null; response?: Record<string, unknown> | null; errorCode?: string | null;
  } = {}): CommandIntent {
    const response = fields.response === undefined ? undefined
      : fields.response === null ? null : encodeJsonRecord(fields.response, 'command response');
    const result = this.db.prepare(`UPDATE command_intents SET state=?,attempt_id=COALESCE(?,attempt_id),
      provider_resource=COALESCE(?,provider_resource), response_json=COALESCE(?,response_json),
      error_code=?, updated_at=? WHERE id=? AND state=?`)
      .run(next, fields.attemptId ?? null, fields.providerResource ?? null, response ?? null, fields.errorCode ?? null, now(), id, expected);
    if (Number(result.changes) !== 1) throw new Error(`Command intent ${id} is no longer ${expected}`);
    return this.getById(id)!;
  }
}

function mapCheckpoint(row: unknown): WorkflowCheckpoint {
  const value = row as Record<string, unknown>;
  return {
    id: requiredString(value.id, 'checkpoint id'), taskId: requiredString(value.task_id, 'checkpoint task'),
    attemptId: nullableString(value.attempt_id), stage: requiredString(value.stage, 'checkpoint stage'),
    revision: Number(value.revision), subjectSha: nullableString(value.subject_sha),
    data: parseJsonRecord(value.data_json, 'checkpoint data'), createdAt: requiredString(value.created_at, 'checkpoint time'),
  };
}

export class WorkflowCheckpointRepository {
  constructor(private readonly db: DatabaseSync) {}
  append(input: { taskId: string; attemptId?: string | null; stage: string; subjectSha?: string | null; data: Record<string, unknown> }): WorkflowCheckpoint {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO workflow_checkpoints (id,task_id,attempt_id,stage,revision,subject_sha,data_json,created_at)
      SELECT ?,?,?,?,COALESCE(MAX(revision),0)+1,?,?,? FROM workflow_checkpoints WHERE task_id=? AND stage=?`)
      .run(id, input.taskId, input.attemptId ?? null, input.stage, input.subjectSha ?? null,
        encodeJsonRecord(input.data, 'checkpoint data'), now(), input.taskId, input.stage);
    return this.getById(id)!;
  }
  getById(id: string): WorkflowCheckpoint | null {
    const row = this.db.prepare('SELECT * FROM workflow_checkpoints WHERE id=?').get(id);
    return row ? mapCheckpoint(row) : null;
  }
  latest(taskId: string, stage: string): WorkflowCheckpoint | null {
    const row = this.db.prepare('SELECT * FROM workflow_checkpoints WHERE task_id=? AND stage=? ORDER BY revision DESC LIMIT 1').get(taskId, stage);
    return row ? mapCheckpoint(row) : null;
  }
}
