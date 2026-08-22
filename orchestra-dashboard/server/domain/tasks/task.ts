import type { OrchestraTaskState } from './states.js';

// ============================================================================
// Orchestra Domain: Task Entity & Classification Models
// ============================================================================

export type ExecutionTarget = 'local' | 'cloud' | 'auto';
export type ExecutionMode = 'orchestra' | 'direct';
export type DirectAgent = 'gemma' | 'antigravity' | 'codex';

export interface TaskRecord {
  id: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  title: string;
  state: OrchestraTaskState;
  target?: ExecutionTarget;
  classification: string | null;
  models: string | null;
  result: string | null;
  error: string | null;
  commitSha: string | null;
  pushStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskClassification {
  type: 'question' | 'implementation' | 'debug' | 'design' | 'review' | 'test';
  mutating: boolean;
  complexity: 'small' | 'normal' | 'deep';
  riskFlags: string[];
  codexRole: 'none' | 'design' | 'debug' | 'review';
  localOperation?: 'none' | 'connect_git_remote';
  executionMode?: ExecutionMode;
  directAgent?: DirectAgent;
  target?: ExecutionTarget;
  title: string;
}

export interface ModelSelection {
  antigravity: string;
  antigravityEffort: 'low' | 'medium' | 'high';
  codex: string | null;
  codexEffort: 'low' | 'medium' | 'high' | 'xhigh' | null;
  primary?: 'gemma' | 'antigravity' | 'codex' | 'jules';
  gemma?: string;
  jules?: string;
}
