// ============================================================================
// Orchestra Types (Domain Re-exports & Presentation Types)
// ============================================================================

export * from './domain/index.js';
import type { OrchestraTaskState } from './domain/index.js';
import type { AgentName } from './domain/index.js';

/** Legacy alias for backwards compatibility */
export type TaskState = OrchestraTaskState;

export interface RunMonitor {
  taskId: string;
  state: OrchestraTaskState;
  health: 'active' | 'waiting' | 'possibly_stalled' | 'needs_attention' | 'complete' | 'failed';
  currentAgent: AgentName;
  phaseStartedAt: string;
  lastActivityAt: string;
  elapsedMs: number;
  inactiveMs: number;
  processAlive: boolean;
  providerState: string | null;
  progressDetail: string;
  nextAction: string | null;
  reviewCycle: number;
  repairAttempt: number;
  changedFiles: string[];
  summary: string;
  stopReason: string | null;
  providerTelemetry: Record<string, unknown>;
  providerActivity: Array<Record<string, unknown>>;
}
