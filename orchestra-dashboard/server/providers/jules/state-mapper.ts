import type { OrchestraTaskState, ProviderExecutionState } from '../../domain/tasks/states.js';

// ============================================================================
// Google Jules Session State Models & Provider State Mapper
// ============================================================================

/**
 * Vendor-specific Google Jules API Session State enum (Alpha).
 * Isolated strictly to the provider adapter layer.
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
  isProviderTerminal: boolean;
  isTaskTerminal: boolean;
  isTerminal: boolean;
  uncertain?: boolean;
  reason?: string;
}

/**
 * Explicit, deterministic mapping from Google Jules cloud session state
 * to provider-neutral ProviderExecutionState and OrchestraTaskState.
 */
export function mapJulesToOrchestraState(
  julesState: JulesSessionState | string | null | undefined
): StateMappingResult {
  const normalized = String(julesState || '').trim().toUpperCase();

  switch (normalized) {
    case 'QUEUED':
      return {
        taskState: 'running',
        executionState: 'DISPATCHING',
        requiresUserAction: false,
        isProviderTerminal: false,
        isTaskTerminal: false,
        isTerminal: false,
      };

    case 'PLANNING':
      return {
        taskState: 'running',
        executionState: 'PLANNING',
        requiresUserAction: false,
        isProviderTerminal: false,
        isTaskTerminal: false,
        isTerminal: false,
      };

    case 'AWAITING_PLAN_APPROVAL':
      return {
        taskState: 'running',
        executionState: 'AWAITING_APPROVAL',
        requiresUserAction: true,
        isProviderTerminal: false,
        isTaskTerminal: false,
        isTerminal: false,
        reason: 'Jules generated an implementation plan awaiting user approval.',
      };

    case 'AWAITING_USER_FEEDBACK':
      return {
        taskState: 'running',
        executionState: 'AWAITING_FEEDBACK',
        requiresUserAction: true,
        isProviderTerminal: false,
        isTaskTerminal: false,
        isTerminal: false,
        reason: 'Jules is waiting for user guidance or feedback.',
      };

    case 'IN_PROGRESS':
      return {
        taskState: 'running',
        executionState: 'WORKING',
        requiresUserAction: false,
        isProviderTerminal: false,
        isTaskTerminal: false,
        isTerminal: false,
      };

    case 'PAUSED':
      return {
        taskState: 'running',
        executionState: 'PAUSED',
        requiresUserAction: true,
        isProviderTerminal: false,
        isTaskTerminal: false,
        isTerminal: false,
        reason: 'Cloud session is paused.',
      };

    case 'COMPLETED':
      return {
        taskState: 'reviewing',
        executionState: 'COMPLETED',
        requiresUserAction: false,
        isProviderTerminal: true,
        isTaskTerminal: false,
        isTerminal: true,
        reason: 'Cloud execution completed. Awaiting review.',
      };

    case 'FAILED':
      return {
        taskState: 'failed',
        executionState: 'FAILED',
        requiresUserAction: false,
        isProviderTerminal: true,
        isTaskTerminal: false,
        isTerminal: true,
        reason: 'Cloud execution failed. The Orchestra task remains recoverable.',
      };

    case 'STATE_UNSPECIFIED':
    default:
      return {
        taskState: 'running',
        executionState: 'UNKNOWN',
        requiresUserAction: false,
        isProviderTerminal: false,
        isTaskTerminal: false,
        isTerminal: false,
        uncertain: true,
        reason: normalized ? `Unknown provider state '${normalized}' degraded safely.` : 'Unspecified provider state.',
      };
  }
}

export function isJulesTerminalState(julesState: JulesSessionState | string | null | undefined): boolean {
  const norm = String(julesState || '').trim().toUpperCase();
  return norm === 'COMPLETED' || norm === 'FAILED';
}
