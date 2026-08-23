import type { ExecutionTarget } from '../tasks/task.js';
import type { ProviderExecutionState } from '../tasks/states.js';

// ============================================================================
// Orchestra Domain: Execution Attempt & Cloud Session Models
// ============================================================================

export type WorkerIdentity = 'antigravity' | 'jules' | 'codex' | 'gemma';
export const WORKER_IDENTITIES: readonly WorkerIdentity[] = ['antigravity', 'jules', 'codex', 'gemma'];
export function isWorkerIdentity(value: unknown): value is WorkerIdentity {
  return typeof value === 'string' && WORKER_IDENTITIES.includes(value as WorkerIdentity);
}

export interface ExecutionAttempt {
  id: string;
  taskId: string;
  target: ExecutionTarget;
  worker: WorkerIdentity;
  providerSessionId?: string | null;
  baseSha: string;
  headSha?: string | null;
  branchName?: string | null;
  prUrl?: string | null;
  state: ProviderExecutionState;
  retryCount: number;
  error?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface CloudSessionReference {
  id: string;
  taskId: string;
  attemptId?: string | null;
  providerId: 'jules';
  sourceName: string;
  sessionResourceName: string;
  remoteSessionId: string;
  dispatchBranch: string;
  targetBranch: string;
  baseSha: string;
  prHeadSha?: string | null;
  prUrl?: string | null;
  state: string;
  lastActivityId?: string | null;
  lastActivityAt?: string | null;
  pollingLeaseExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
