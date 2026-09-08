export const JULES_HANDOFF_KINDS = [
  'plan_approval', 'user_feedback', 'paused', 'verification_repair',
  'review_repair', 'waiting_for_head', 'final_review', 'integration_readiness',
] as const;

export type JulesHandoffKind = typeof JULES_HANDOFF_KINDS[number];
export type JulesHandoffHandler = 'deterministic' | 'gemma' | 'codex';
export type JulesHandoffModel = 'gemma' | 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol' | null;
export type JulesAutomationState =
  | 'provider_completed' | 'feedback_acknowledged' | 'awaiting_provider_resume' | 'provider_resumed'
  | 'awaiting_new_head' | 'changed_head_ready'
  | 'locally_verifying' | 'independently_reviewing' | 'reviewed' | 'integrated'
  | 'locally_synchronized' | 'waiting' | 'blocked';

export interface JulesChecklistItem {
  id: string;
  text: string;
  source: 'request' | 'repository_contract' | 'verification' | 'reviewer';
  status: 'open' | 'resolved' | 'preserved';
  introducedBy: string;
  resolvedBy: string | null;
  evidence: string[];
}

export interface JulesAcceptanceChecklist {
  version: 1;
  taskId: string;
  fingerprint: string;
  items: JulesChecklistItem[];
}

export interface JulesPlanDelta {
  version: 1;
  planId: string;
  planFingerprint: string;
  previousPlanFingerprint: string | null;
  changedSections: string[];
  unresolvedChecklistItemIds: string[];
  preservedChecklistItemIds: string[];
}

export interface JulesHandoffDecision {
  version: 1;
  kind: JulesHandoffKind;
  handler: JulesHandoffHandler;
  model: JulesHandoffModel;
  effort: 'none' | 'low' | 'medium' | 'high';
  reason: string;
  promptFingerprint: string;
  decisionFingerprint: string;
  tokenUsage: { input: number; output: number; total: number } | null;
  escalationHistory: Array<{ model: JulesHandoffModel; effort: string; reason: string }>;
  outcome: 'respond' | 'approve' | 'block' | 'wait' | 'review' | 'integrate';
  response: string | null;
  createdAt: string;
}

export interface JulesOutstandingRepair {
  version: 1;
  taskId: string;
  headSha: string;
  findingsFingerprint: string;
  repairId: string;
  feedbackCommandKey: string;
  status: 'pending' | 'feedback_acknowledged' | 'awaiting_new_head' | 'head_changed' | 'local_takeover';
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface JulesAutomationStatus {
  version: 1;
  state: JulesAutomationState;
  handler: JulesHandoffHandler | null;
  model: JulesHandoffModel;
  effort: string | null;
  reason: string | null;
  pendingCommand: { kind: string; idempotencyKey: string; state: string } | null;
  retryAt: string | null;
  authoritativeTaskState: string;
  updatedAt: string;
}

export class JulesAutomationValidationError extends Error {
  readonly code = 'JULES_AUTOMATION_STATE_CORRUPT';
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JulesAutomationValidationError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function required(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new JulesAutomationValidationError(`${label} is invalid.`);
  return value;
}

export function parseJulesOutstandingRepair(value: unknown): JulesOutstandingRepair {
  const input = record(value, 'Outstanding repair');
  if (input.version !== 1) throw new JulesAutomationValidationError('Outstanding repair version is unsupported.');
  const status = required(input.status, 'Outstanding repair status');
  if (!['pending', 'feedback_acknowledged', 'awaiting_new_head', 'head_changed', 'local_takeover'].includes(status)) {
    throw new JulesAutomationValidationError('Outstanding repair status is unknown.');
  }
  const headSha = required(input.headSha, 'Outstanding repair head SHA', 64).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(headSha)) throw new JulesAutomationValidationError('Outstanding repair head SHA is invalid.');
  return {
    version: 1,
    taskId: required(input.taskId, 'Outstanding repair task ID', 200),
    headSha,
    findingsFingerprint: required(input.findingsFingerprint, 'Findings fingerprint', 128),
    repairId: required(input.repairId, 'Repair ID', 300),
    feedbackCommandKey: required(input.feedbackCommandKey, 'Feedback command key', 500),
    status: status as JulesOutstandingRepair['status'],
    acknowledgedAt: input.acknowledgedAt === null ? null : required(input.acknowledgedAt, 'Acknowledgement time', 100),
    createdAt: required(input.createdAt, 'Repair creation time', 100),
  };
}

export function parseJulesAutomationStatus(value: unknown): JulesAutomationStatus {
  const input = record(value, 'Jules automation status');
  if (input.version !== 1) throw new JulesAutomationValidationError('Jules automation status version is unsupported.');
  const states: JulesAutomationState[] = ['provider_completed', 'feedback_acknowledged', 'awaiting_provider_resume', 'provider_resumed', 'awaiting_new_head', 'changed_head_ready', 'locally_verifying', 'independently_reviewing', 'reviewed', 'integrated', 'locally_synchronized', 'waiting', 'blocked'];
  const state = required(input.state, 'Automation state') as JulesAutomationState;
  if (!states.includes(state)) throw new JulesAutomationValidationError('Jules automation state is unknown.');
  const handler = input.handler === null ? null : required(input.handler, 'Automation handler') as JulesHandoffHandler;
  if (handler !== null && !['deterministic', 'gemma', 'codex'].includes(handler)) throw new JulesAutomationValidationError('Automation handler is unknown.');
  const model = input.model === null ? null : required(input.model, 'Automation model') as JulesHandoffModel;
  if (model !== null && !['gemma', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'].includes(model)) throw new JulesAutomationValidationError('Automation model is unknown.');
  return {
    version: 1, state, handler, model,
    effort: input.effort === null ? null : required(input.effort, 'Automation effort', 20),
    reason: input.reason === null ? null : required(input.reason, 'Automation reason'),
    pendingCommand: input.pendingCommand === null ? null : record(input.pendingCommand, 'Pending command') as JulesAutomationStatus['pendingCommand'],
    retryAt: input.retryAt === null ? null : required(input.retryAt, 'Retry time', 100),
    authoritativeTaskState: required(input.authoritativeTaskState, 'Authoritative task state', 100),
    updatedAt: required(input.updatedAt, 'Automation update time', 100),
  };
}

export function parseJulesAcceptanceChecklist(value: unknown): JulesAcceptanceChecklist {
  const input = record(value, 'Jules acceptance checklist');
  if (input.version !== 1 || !Array.isArray(input.items)) throw new JulesAutomationValidationError('Jules acceptance checklist is malformed.');
  const items = input.items.map((value, index) => {
    const item = record(value, `Checklist item ${index}`);
    const source = required(item.source, 'Checklist source') as JulesChecklistItem['source'];
    const status = required(item.status, 'Checklist status') as JulesChecklistItem['status'];
    if (!['request', 'repository_contract', 'verification', 'reviewer'].includes(source) || !['open', 'resolved', 'preserved'].includes(status)) {
      throw new JulesAutomationValidationError('Checklist item source or status is unknown.');
    }
    if (!Array.isArray(item.evidence) || !item.evidence.every((entry) => typeof entry === 'string')) throw new JulesAutomationValidationError('Checklist evidence is malformed.');
    return { id: required(item.id, 'Checklist ID', 128), text: required(item.text, 'Checklist text'), source, status,
      introducedBy: required(item.introducedBy, 'Checklist introduction', 128), resolvedBy: item.resolvedBy === null ? null : required(item.resolvedBy, 'Checklist resolution', 128),
      evidence: item.evidence.slice(0, 100).map(String) };
  });
  return { version: 1, taskId: required(input.taskId, 'Checklist task ID', 200), fingerprint: required(input.fingerprint, 'Checklist fingerprint', 128), items };
}

export function parseJulesPlanDelta(value: unknown): JulesPlanDelta {
  const input = record(value, 'Jules plan delta');
  if (input.version !== 1) throw new JulesAutomationValidationError('Jules plan delta version is unsupported.');
  const strings = (value: unknown, label: string) => {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new JulesAutomationValidationError(`${label} is malformed.`);
    return value.slice(0, 1_000).map(String);
  };
  return { version: 1, planId: required(input.planId, 'Delta plan ID', 500), planFingerprint: required(input.planFingerprint, 'Delta fingerprint', 128),
    previousPlanFingerprint: input.previousPlanFingerprint === null ? null : required(input.previousPlanFingerprint, 'Previous plan fingerprint', 128),
    changedSections: strings(input.changedSections, 'Changed sections'), unresolvedChecklistItemIds: strings(input.unresolvedChecklistItemIds, 'Unresolved checklist IDs'),
    preservedChecklistItemIds: strings(input.preservedChecklistItemIds, 'Preserved checklist IDs') };
}

export function parseJulesHandoffDecision(value: unknown): JulesHandoffDecision {
  const input = record(value, 'Jules handoff decision');
  if (input.version !== 1 || !JULES_HANDOFF_KINDS.includes(input.kind as JulesHandoffKind)) throw new JulesAutomationValidationError('Jules handoff decision kind is invalid.');
  const handler = required(input.handler, 'Decision handler') as JulesHandoffHandler;
  const model = input.model === null ? null : required(input.model, 'Decision model') as JulesHandoffModel;
  const outcome = required(input.outcome, 'Decision outcome') as JulesHandoffDecision['outcome'];
  if (!['deterministic', 'gemma', 'codex'].includes(handler) || !['respond', 'approve', 'block', 'wait', 'review', 'integrate'].includes(outcome)) {
    throw new JulesAutomationValidationError('Jules handoff decision contains an unknown handler or outcome.');
  }
  if (model !== null && !['gemma', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'].includes(model)) throw new JulesAutomationValidationError('Decision model is unknown.');
  if (!Array.isArray(input.escalationHistory)) throw new JulesAutomationValidationError('Decision escalation history is malformed.');
  return { version: 1, kind: input.kind as JulesHandoffKind, handler, model,
    effort: required(input.effort, 'Decision effort', 20) as JulesHandoffDecision['effort'], reason: required(input.reason, 'Decision reason'),
    promptFingerprint: required(input.promptFingerprint, 'Prompt fingerprint', 128), decisionFingerprint: required(input.decisionFingerprint, 'Decision fingerprint', 128),
    tokenUsage: input.tokenUsage === null ? null : record(input.tokenUsage, 'Token usage') as JulesHandoffDecision['tokenUsage'],
    escalationHistory: input.escalationHistory as JulesHandoffDecision['escalationHistory'], outcome,
    response: input.response === null ? null : required(input.response, 'Decision response'), createdAt: required(input.createdAt, 'Decision creation time', 100) };
}
