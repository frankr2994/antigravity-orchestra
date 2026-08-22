// ============================================================================
// Orchestra Domain: State Models & Hierarchy
// ============================================================================

/**
 * Canonical Orchestra Task State Machine.
 * Represents the overall task lifecycle in Orchestra Core.
 */
export type OrchestraTaskState =
  | 'queued'
  | 'preflight'
  | 'baseline_required'
  | 'routing'
  | 'running'
  | 'recovering'
  | 'recovery_required'
  | 'reviewing'
  | 'verifying'
  | 'summarizing'
  | 'committing'
  | 'pushing'
  | 'completed'
  | 'completed_unpushed'
  | 'failed'
  | 'cancelled'
  | 'review_disputed';

/**
 * Provider-neutral execution state.
 * Reflects the status of an active worker attempting a task.
 */
export type ProviderExecutionState =
  | 'IDLE'
  | 'DISPATCHING'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'AWAITING_FEEDBACK'
  | 'WORKING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Vendor-specific Google Jules API Session State enum (Alpha).
 * Isolated to the provider adapter layer.
 */
export type JulesSessionState =
  | 'STATE_UNSPECIFIED'
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_USER_FEEDBACK'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED';

export interface StateMappingResult {
  taskState: OrchestraTaskState;
  executionState: ProviderExecutionState;
  requiresUserAction: boolean;
  isTerminal: boolean;
  reason?: string;
}

/**
 * Explicit, deterministic mapping from Google Jules cloud session state
 * to provider-neutral ProviderExecutionState and OrchestraTaskState.
 * Unknown future states safely degrade to WORKING without crashing.
 */
export function mapJulesToOrchestraState(julesState: JulesSessionState | string | null | undefined): StateMappingResult {
  const normalized = String(julesState || '').trim().toUpperCase();

  switch (normalized) {
    case 'QUEUED':
      return {
        taskState: 'running',
        executionState: 'DISPATCHING',
        requiresUserAction: false,
        isTerminal: false,
      };

    case 'PLANNING':
      return {
        taskState: 'running',
        executionState: 'PLANNING',
        requiresUserAction: false,
        isTerminal: false,
      };

    case 'AWAITING_PLAN_APPROVAL':
      return {
        taskState: 'running',
        executionState: 'AWAITING_APPROVAL',
        requiresUserAction: true,
        isTerminal: false,
        reason: 'Jules generated an implementation plan awaiting user approval.',
      };

    case 'AWAITING_USER_FEEDBACK':
      return {
        taskState: 'running',
        executionState: 'AWAITING_FEEDBACK',
        requiresUserAction: true,
        isTerminal: false,
        reason: 'Jules is waiting for user guidance or feedback.',
      };

    case 'IN_PROGRESS':
      return {
        taskState: 'running',
        executionState: 'WORKING',
        requiresUserAction: false,
        isTerminal: false,
      };

    case 'PAUSED':
      return {
        taskState: 'running',
        executionState: 'PAUSED',
        requiresUserAction: true,
        isTerminal: false,
        reason: 'Cloud session is paused.',
      };

    case 'COMPLETED':
      return {
        taskState: 'reviewing',
        executionState: 'COMPLETED',
        requiresUserAction: false,
        isTerminal: false,
      };

    case 'FAILED':
      return {
        taskState: 'failed',
        executionState: 'FAILED',
        requiresUserAction: false,
        isTerminal: true,
        reason: 'Cloud execution failed.',
      };

    case 'STATE_UNSPECIFIED':
    default:
      return {
        taskState: 'running',
        executionState: 'WORKING',
        requiresUserAction: false,
        isTerminal: false,
        reason: normalized ? `Unknown provider state '${normalized}' degraded safely.` : undefined,
      };
  }
}

export function isJulesTerminalState(julesState: JulesSessionState | string | null | undefined): boolean {
  const norm = String(julesState || '').trim().toUpperCase();
  return norm === 'COMPLETED' || norm === 'FAILED';
}
