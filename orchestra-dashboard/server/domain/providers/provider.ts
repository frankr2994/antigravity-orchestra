import type { ExecutionTarget } from '../tasks/task.js';
import type { ProviderExecutionState } from '../tasks/states.js';
import type { WorkerIdentity } from '../execution/attempt.js';

// ============================================================================
// Orchestra Domain: Provider Interfaces & Contracts
// ============================================================================

export interface ProviderCapability {
  readonly canStream: boolean;
  readonly canApprovePlan: boolean;
  readonly canSendFeedback: boolean;
  readonly canCancel: boolean;
  readonly requiresCleanTree: boolean;
  readonly requiresRemoteRepo: boolean;
}

export interface PreflightContext {
  projectId: string;
  projectRoot: string;
  targetBranch?: string;
  baseSha?: string;
  isGit: boolean;
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  remoteUrl?: string | null;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly warning?: string;
  readonly immutableDispatchBranch?: string;
}

export interface StartExecutionRequest {
  readonly taskId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly baseSha: string;
  readonly dispatchBranch?: string;
  readonly requirePlanApproval?: boolean;
  readonly model?: string;
}

export interface ProviderSnapshot {
  readonly sessionId: string;
  readonly state: ProviderExecutionState;
  readonly rawProviderState?: string;
  readonly progress?: string;
  readonly prUrl?: string;
  readonly prHeadSha?: string;
  readonly error?: string;
  readonly requiresUserAction?: boolean;
}

export interface ExecutionProvider {
  readonly id: WorkerIdentity;
  readonly target: ExecutionTarget;
  readonly capabilities: ProviderCapability;

  preflight(context: PreflightContext): Promise<PreflightResult>;
  start(request: StartExecutionRequest): Promise<{ sessionId: string; state: ProviderExecutionState }>;
  inspect(sessionId: string): Promise<ProviderSnapshot>;
  approvePlan?(sessionId: string): Promise<void>;
  sendFeedback?(sessionId: string, message: string): Promise<void>;
  stop?(sessionId: string): Promise<{ stopped: boolean; reason?: string }>;
}
