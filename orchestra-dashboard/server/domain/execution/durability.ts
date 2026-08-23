export type CommandIntentState = 'pending' | 'acknowledged' | 'ambiguous' | 'failed';
export interface CommandIntent {
  id: string;
  taskId: string;
  attemptId: string | null;
  kind: string;
  idempotencyKey: string;
  requestHash: string;
  state: CommandIntentState;
  providerResource: string | null;
  response: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowCheckpoint {
  id: string;
  taskId: string;
  attemptId: string | null;
  stage: string;
  revision: number;
  subjectSha: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ActivityCursor {
  cloudSessionId: string;
  nextPageToken: string | null;
  lastActivityId: string | null;
  lastActivityAt: string | null;
  nextPollAt: string;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  version: number;
  updatedAt: string;
}

export interface ResourceLease {
  resourceType: string;
  resourceId: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: string;
  acquiredAt: string;
}

export type ManagedGitResourceKind = 'dispatch_ref' | 'review_ref' | 'worktree' | 'integration_ref';
export type ManagedGitResourceState = 'active' | 'cleanup_pending' | 'cleaned' | 'cleanup_failed';
export interface ManagedGitResource {
  id: string;
  taskId: string;
  attemptId: string | null;
  repositoryRoot: string;
  kind: ManagedGitResourceKind;
  resourceValue: string;
  state: ManagedGitResourceState;
  cleanupAfter: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowEvidenceKind =
  | 'routing' | 'preflight' | 'provider_output' | 'review'
  | 'verification' | 'repair' | 'integration' | 'cleanup';
export interface WorkflowEvidence {
  id: string;
  taskId: string;
  attemptId: string | null;
  kind: WorkflowEvidenceKind;
  subjectSha: string | null;
  outcome: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type OutboxState = 'pending' | 'publishing' | 'published' | 'failed';
export interface WorkflowOutboxItem {
  id: string;
  taskId: string;
  topic: string;
  payload: Record<string, unknown>;
  state: OutboxState;
  attempts: number;
  availableAt: string;
  publishedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
