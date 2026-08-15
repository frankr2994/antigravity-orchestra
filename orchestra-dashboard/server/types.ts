export type AgentName = 'system' | 'antigravity' | 'codex' | 'gemma' | 'git' | 'verification';
export type TaskState =
  | 'queued' | 'preflight' | 'baseline_required' | 'routing' | 'running'
  | 'recovering' | 'recovery_required' | 'reviewing' | 'verifying' | 'summarizing' | 'committing' | 'pushing'
  | 'completed' | 'completed_unpushed' | 'failed' | 'cancelled'
  | 'review_disputed';

export interface Project {
  id: string;
  name: string;
  root: string;
  gitRoot: string | null;
  onboardingStatus: string;
  onboardingVersion: string | null;
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  antigravityConversationId: string | null;
  summary: string | null;
  summaryUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  taskId: string | null;
  role: 'user' | 'assistant' | 'system';
  agent: AgentName;
  content: string;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  title: string;
  state: TaskState;
  classification: string | null;
  models: string | null;
  result: string | null;
  error: string | null;
  commitSha: string | null;
  pushStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionMode = 'orchestra' | 'direct';
export type DirectAgent = 'gemma' | 'antigravity' | 'codex';

export interface TaskClassification {
  type: 'question' | 'implementation' | 'debug' | 'design' | 'review' | 'test';
  mutating: boolean;
  complexity: 'small' | 'normal' | 'deep';
  riskFlags: string[];
  codexRole: 'none' | 'design' | 'debug' | 'review';
  localOperation?: 'none' | 'connect_git_remote';
  executionMode?: ExecutionMode;
  directAgent?: DirectAgent;
  title: string;
}

export interface ModelSelection {
  antigravity: string;
  antigravityEffort: 'low' | 'medium' | 'high';
  codex: string | null;
  codexEffort: 'low' | 'medium' | 'high' | 'xhigh' | null;
  primary?: 'gemma' | 'antigravity' | 'codex';
  gemma?: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  agent: AgentName;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface RunMonitor {
  taskId: string;
  state: TaskState;
  health: 'active' | 'waiting' | 'possibly_stalled' | 'needs_attention' | 'complete' | 'failed';
  currentAgent: AgentName;
  phaseStartedAt: string;
  lastActivityAt: string;
  elapsedMs: number;
  inactiveMs: number;
  processAlive: boolean;
  reviewCycle: number;
  repairAttempt: number;
  changedFiles: string[];
  summary: string;
  stopReason: string | null;
  providerTelemetry: Record<string, unknown>;
  providerActivity: Array<Record<string, unknown>>;
}
