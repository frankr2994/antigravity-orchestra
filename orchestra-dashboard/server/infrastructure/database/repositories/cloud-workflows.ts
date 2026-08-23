import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { encodeJsonRecord, parseJsonRecord, requiredString } from './codec.js';

export type CloudWorkflowNodeState = 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'blocked';
export interface CloudWorkflowNode { id: string; batchId: string; ordinal: number; prompt: string; dependencies: number[]; state: CloudWorkflowNodeState; taskId: string | null; errorCode: string | null; }
export interface CloudWorkflowBatch { id: string; projectId: string; idempotencyKey: string; requestHash: string; state: 'running' | 'completed' | 'failed' | 'blocked'; maxConcurrency: number; nodes: CloudWorkflowNode[]; }
const now = () => new Date().toISOString();
function node(row: unknown): CloudWorkflowNode {
  const value = row as Record<string, unknown>; const parsed = parseJsonRecord(value.dependencies_json, 'workflow dependencies');
  const dependencies = parsed.values;
  if (!Array.isArray(dependencies) || !dependencies.every(Number.isSafeInteger)) throw new TypeError('Persisted workflow dependencies are invalid');
  return { id: requiredString(value.id, 'workflow node'), batchId: requiredString(value.batch_id, 'workflow batch'), ordinal: Number(value.ordinal),
    prompt: requiredString(value.prompt, 'workflow prompt'), dependencies: dependencies as number[], state: requiredString(value.state, 'workflow node state') as CloudWorkflowNodeState,
    taskId: value.task_id ? String(value.task_id) : null, errorCode: value.error_code ? String(value.error_code) : null };
}
export class CloudWorkflowRepository {
  constructor(private readonly db: DatabaseSync) {}
  create(input: { projectId: string; idempotencyKey: string; requestHash: string; maxConcurrency: number; nodes: Array<{ prompt: string; dependencies: number[] }> }): CloudWorkflowBatch {
    const existing = this.getByKey(input.idempotencyKey); if (existing) { if (existing.requestHash !== input.requestHash) throw new Error('Workflow idempotency key conflict'); return existing; }
    const id = randomUUID(); const stamp = now();
    this.db.prepare("INSERT INTO cloud_workflow_batches (id,project_id,idempotency_key,request_hash,state,max_concurrency,created_at,updated_at) VALUES (?,?,?,?,'running',?,?,?)")
      .run(id, input.projectId, input.idempotencyKey, input.requestHash, input.maxConcurrency, stamp, stamp);
    const insert = this.db.prepare("INSERT INTO cloud_workflow_nodes (id,batch_id,ordinal,prompt,dependencies_json,state,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)");
    input.nodes.forEach((item, ordinal) => insert.run(randomUUID(), id, ordinal, item.prompt, encodeJsonRecord({ values: item.dependencies }, 'workflow dependencies'), stamp, stamp));
    return this.get(id)!;
  }
  get(id: string): CloudWorkflowBatch | null {
    const row = this.db.prepare('SELECT * FROM cloud_workflow_batches WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: String(row.id), projectId: String(row.project_id), idempotencyKey: String(row.idempotency_key), requestHash: String(row.request_hash), state: String(row.state) as CloudWorkflowBatch['state'],
      maxConcurrency: Number(row.max_concurrency), nodes: this.db.prepare('SELECT * FROM cloud_workflow_nodes WHERE batch_id=? ORDER BY ordinal').all(id).map(node) };
  }
  getByKey(key: string): CloudWorkflowBatch | null { const row = this.db.prepare('SELECT id FROM cloud_workflow_batches WHERE idempotency_key=?').get(key) as { id: string } | undefined; return row ? this.get(row.id) : null; }
  listRunning(): CloudWorkflowBatch[] { return (this.db.prepare("SELECT id FROM cloud_workflow_batches WHERE state='running' ORDER BY created_at").all() as Array<{ id: string }>).map((row) => this.get(row.id)!); }
  getByTask(taskId: string): CloudWorkflowNode | null { const row = this.db.prepare('SELECT * FROM cloud_workflow_nodes WHERE task_id=?').get(taskId); return row ? node(row) : null; }
  transitionNode(id: string, expected: CloudWorkflowNodeState, next: CloudWorkflowNodeState, fields: { taskId?: string | null; errorCode?: string | null } = {}): boolean {
    const result = this.db.prepare('UPDATE cloud_workflow_nodes SET state=?,task_id=COALESCE(?,task_id),error_code=?,updated_at=? WHERE id=? AND state=?')
      .run(next, fields.taskId ?? null, fields.errorCode ?? null, now(), id, expected); return Number(result.changes) === 1;
  }
  updateBatch(id: string, state: CloudWorkflowBatch['state']): void { this.db.prepare('UPDATE cloud_workflow_batches SET state=?,updated_at=? WHERE id=?').run(state, now(), id); }
}
