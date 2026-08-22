// ============================================================================
// Orchestra Domain: Canonical Event & Agent Models
// ============================================================================

export type AgentName = 'system' | 'antigravity' | 'codex' | 'gemma' | 'jules' | 'git' | 'verification';

export interface TaskEvent {
  id: number;
  taskId: string;
  agent: AgentName;
  type: string;
  payload: unknown;
  createdAt: string;
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
