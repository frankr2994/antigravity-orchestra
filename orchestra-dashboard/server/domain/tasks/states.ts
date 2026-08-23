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

export const ALL_ORCHESTRA_TASK_STATES: readonly OrchestraTaskState[] = [
  'queued',
  'preflight',
  'baseline_required',
  'routing',
  'running',
  'recovering',
  'recovery_required',
  'reviewing',
  'verifying',
  'summarizing',
  'committing',
  'pushing',
  'completed',
  'completed_unpushed',
  'failed',
  'cancelled',
  'review_disputed',
];

export function isOrchestraTaskState(val: unknown): val is OrchestraTaskState {
  return typeof val === 'string' && (ALL_ORCHESTRA_TASK_STATES as readonly string[]).includes(val);
}

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
  | 'CANCELLED'
  | 'UNKNOWN';

/**
 * Checks if a task state is terminal in Orchestra.
 */
export function isTerminalTaskState(state: OrchestraTaskState): boolean {
  return state === 'completed' || state === 'cancelled';
}

/**
 * Canonical state transition matrix for Orchestra Task State Machine.
 */
export const TASK_STATE_TRANSITIONS: Readonly<Record<OrchestraTaskState, readonly OrchestraTaskState[]>> = {
  queued: ['preflight', 'routing', 'running', 'failed', 'cancelled'],
  preflight: ['baseline_required', 'routing', 'running', 'reviewing', 'failed', 'cancelled'],
  baseline_required: ['queued', 'preflight', 'running', 'failed', 'cancelled'],
  routing: ['running', 'failed', 'cancelled'],
  running: [
    'reviewing',
    'verifying',
    'recovering',
    'recovery_required',
    'review_disputed',
    'summarizing',
    'committing',
    'completed',
    'completed_unpushed',
    'failed',
    'cancelled',
  ],
  recovering: ['running', 'reviewing', 'failed', 'cancelled'],
  recovery_required: ['recovering', 'running', 'queued', 'failed', 'cancelled'],
  reviewing: ['running', 'verifying', 'summarizing', 'committing', 'recovering', 'review_disputed', 'completed', 'failed', 'cancelled'],
  review_disputed: ['running', 'recovering', 'summarizing', 'committing', 'failed', 'cancelled'],
  verifying: ['summarizing', 'committing', 'recovering', 'reviewing', 'failed', 'cancelled'],
  summarizing: ['committing', 'pushing', 'completed', 'completed_unpushed', 'failed', 'cancelled'],
  committing: ['pushing', 'completed', 'completed_unpushed', 'failed', 'cancelled'],
  pushing: ['completed', 'completed_unpushed', 'failed', 'cancelled'],
  completed: [],
  completed_unpushed: ['pushing', 'completed', 'failed', 'cancelled'],
  failed: ['queued', 'recovering', 'recovery_required'],
  cancelled: [],
};

/**
 * Validates whether a state transition from `from` to `to` is legally allowed.
 * Terminal states (completed, cancelled) cannot transition to any state, including themselves.
 */
export function isValidTaskStateTransition(from: OrchestraTaskState, to: OrchestraTaskState): boolean {
  if (isTerminalTaskState(from)) {
    return false;
  }
  if (from === to) {
    return true;
  }
  const allowed = TASK_STATE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}
