import type { OrchestraTaskState } from './states.js';
import type { ReviewVerdict, VerificationResult } from '../execution/review.js';

// ============================================================================
// Orchestra Domain: Canonical Event & Agent Models
// ============================================================================

export type AgentName = 'system' | 'antigravity' | 'codex' | 'gemma' | 'jules' | 'git' | 'verification' | 'orchestra';

export interface BaseTaskEvent {
  id: number;
  taskId: string;
  agent: AgentName;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// Core Task Events
// ----------------------------------------------------------------------------

export interface TaskStartedEvent extends BaseTaskEvent {
  type: 'task.started';
  payload: { prompt: string; [key: string]: unknown };
}

export interface TaskStateEvent extends BaseTaskEvent {
  type: 'task.state';
  payload: { state: OrchestraTaskState; previousState?: OrchestraTaskState; reason?: string };
}

export interface TaskCompletedEvent extends BaseTaskEvent {
  type: 'task.completed';
  payload: { commitSha?: string; prUrl?: string; summary?: string; [key: string]: unknown };
}

export interface TaskFailedEvent extends BaseTaskEvent {
  type: 'task.failed';
  payload: { error: string; code?: string; [key: string]: unknown };
}

export interface TaskCancelledEvent extends BaseTaskEvent {
  type: 'task.cancelled';
  payload: { remoteSessionId?: string; reason?: string; [key: string]: unknown };
}

export interface TaskErrorEvent extends BaseTaskEvent {
  type: 'task.error';
  payload: { message: string; fatal?: boolean; [key: string]: unknown };
}

export interface TaskRecoveryEvent extends BaseTaskEvent {
  type: 'task.recovery';
  payload: { message: string; [key: string]: unknown };
}

export interface TaskRecoveryRequiredEvent extends BaseTaskEvent {
  type: 'task.recovery-required';
  payload: { message?: string; reason?: string; files?: string[]; [key: string]: unknown };
}

export interface TaskRetryEvent extends BaseTaskEvent {
  type: 'task.retry';
  payload: { message: string; [key: string]: unknown };
}

export interface TaskSteerEvent extends BaseTaskEvent {
  type: 'task.steer';
  payload: { guidance: string; message: string; [key: string]: unknown };
}

export interface TaskContinuationEvent extends BaseTaskEvent {
  type: 'task.continuation';
  payload: { guidance?: string; message: string; [key: string]: unknown };
}

export interface TaskDisputedEvent extends BaseTaskEvent {
  type: 'task.disputed' | 'task.review-disputed';
  payload: { reason?: string; findingsCount?: number; [key: string]: unknown };
}

export interface TaskRepairProgressEvent extends BaseTaskEvent {
  type: 'task.repair-progress';
  payload: { cycle: number; strategy: string; description?: string; [key: string]: unknown };
}

export interface TaskRoutedEvent extends BaseTaskEvent {
  type: 'task.routed';
  payload: { target: string; worker: string; reason?: string; [key: string]: unknown };
}

export interface TaskTakeoverLocalEvent extends BaseTaskEvent {
  type: 'task.takeover_local';
  payload: { reason?: string; message?: string; [key: string]: unknown };
}

export interface TaskModelTakeoverEvent extends BaseTaskEvent {
  type: 'task.model-takeover';
  payload: { message: string; from?: string; to?: string; attempt?: number; [key: string]: unknown };
}

export interface TaskProviderRecoveryEvent extends BaseTaskEvent {
  type: 'task.provider-recovery';
  payload: { message: string; provider?: string; status?: string | null; [key: string]: unknown };
}

// ----------------------------------------------------------------------------
// Agent Events
// ----------------------------------------------------------------------------

export interface AgentStartedEvent extends BaseTaskEvent {
  type: 'agent.started';
  payload: { phase?: string; role?: string; agent?: AgentName; model?: string; effort?: string; [key: string]: unknown };
}

export interface AgentOutputEvent extends BaseTaskEvent {
  type: 'agent.output';
  payload: { text: string; stream?: boolean };
}

export interface AgentProgressEvent extends BaseTaskEvent {
  type: 'agent.progress';
  payload: { message?: string; [key: string]: unknown };
}

export interface AgentCompletedEvent extends BaseTaskEvent {
  type: 'agent.completed';
  payload: { phase?: string; role?: string; agent?: AgentName; summary?: string; result?: unknown; exitCode?: number; [key: string]: unknown };
}

export interface AgentFailedEvent extends BaseTaskEvent {
  type: 'agent.failed';
  payload: { agent?: AgentName; error?: string; [key: string]: unknown };
}

// ----------------------------------------------------------------------------
// Verification & Review Events
// ----------------------------------------------------------------------------

export interface VerificationResultEvent extends BaseTaskEvent {
  type: 'verification.result';
  payload: VerificationResult;
}

export interface ReviewVerdictEvent extends BaseTaskEvent {
  type: 'review.verdict';
  payload: ReviewVerdict;
}

export interface ReviewStartedEvent extends BaseTaskEvent {
  type: 'review.started';
  payload: { reviewer?: string; model?: string; [key: string]: unknown };
}

export interface ReviewCompletedEvent extends BaseTaskEvent {
  type: 'review.completed';
  payload: { verdict?: string; summary?: string; [key: string]: unknown };
}

export interface ReviewFindingEvent extends BaseTaskEvent {
  type: 'review.finding';
  payload: { severity?: string; explanation?: string; file?: string; line?: number; [key: string]: unknown };
}

// ----------------------------------------------------------------------------
// Git Events
// ----------------------------------------------------------------------------

export interface GitCommitEvent extends BaseTaskEvent {
  type: 'git.commit';
  payload: { kind?: string; sha?: string; hash?: string; title?: string; message?: string; files?: string[] };
}

export interface GitPushEvent extends BaseTaskEvent {
  type: 'git.push';
  payload: { pushed?: boolean; remote?: string; branch?: string; [key: string]: unknown };
}

export interface GitRemoteEvent extends BaseTaskEvent {
  type: 'git.remote';
  payload: { remote?: string; branch?: string; url?: string; [key: string]: unknown };
}

export interface GitBaselineRequiredEvent extends BaseTaskEvent {
  type: 'git.baseline-required';
  payload: { files?: string[]; message?: string };
}

// ----------------------------------------------------------------------------
// Cloud / Jules Events
// ----------------------------------------------------------------------------

export interface CloudDispatchingEvent extends BaseTaskEvent {
  type: 'cloud.dispatching';
  payload: { source?: string; branch?: string };
}

export interface CloudDispatchedEvent extends BaseTaskEvent {
  type: 'cloud.dispatched';
  payload: { remoteSessionId: string; source: string; branch: string; autoPr?: boolean; requirePlanApproval?: boolean };
}

export interface CloudActivityEvent extends BaseTaskEvent {
  type: 'cloud.activity';
  payload: { activity?: unknown; [key: string]: unknown };
}

export interface CloudPlanReceivedEvent extends BaseTaskEvent {
  type: 'cloud.plan_received';
  payload: { remoteSessionId: string; plan: unknown };
}

export interface CloudPlanApprovedEvent extends BaseTaskEvent {
  type: 'cloud.plan_approved';
  payload: { remoteSessionId: string };
}

export interface CloudMessageSentEvent extends BaseTaskEvent {
  type: 'cloud.message_sent';
  payload: { remoteSessionId: string; prompt: string };
}

export interface CloudFeedbackSentEvent extends BaseTaskEvent {
  type: 'cloud.feedback_sent';
  payload: { remoteSessionId: string; prompt?: string; message?: string; [key: string]: unknown };
}

export interface CloudRepairRequestedEvent extends BaseTaskEvent {
  type: 'cloud.repair_requested';
  payload: { remoteSessionId: string; cycle?: number; findingsCount?: number; [key: string]: unknown };
}

export interface CloudReviewedEvent extends BaseTaskEvent {
  type: 'cloud.reviewed';
  payload: { remoteSessionId: string; verdict: string; findingsCount: number; [key: string]: unknown };
}

export interface CloudCompletedEvent extends BaseTaskEvent {
  type: 'cloud.completed';
  payload: { remoteSessionId: string; prUrl?: string; prHeadSha?: string; state?: string };
}

export interface CloudFailedEvent extends BaseTaskEvent {
  type: 'cloud.failed';
  payload: { remoteSessionId: string; error?: string; state?: string };
}

export interface CloudCancelledEvent extends BaseTaskEvent {
  type: 'cloud.cancelled';
  payload: { remoteSessionId: string };
}

export interface CloudPrImportedEvent extends BaseTaskEvent {
  type: 'cloud.pr_imported';
  payload: { prUrl: string; branch?: string; [key: string]: unknown };
}

// ----------------------------------------------------------------------------
// System & Routing Events
// ----------------------------------------------------------------------------

export interface RoutingDecisionEvent extends BaseTaskEvent {
  type: 'routing.decision';
  payload: { target: string; worker: string; reason: string; preflightOk?: boolean; [key: string]: unknown };
}

export interface RoutingAdjustmentEvent extends BaseTaskEvent {
  type: 'routing.adjustment';
  payload: { message: string; [key: string]: unknown };
}

export interface McpCapabilityEvent extends BaseTaskEvent {
  type: 'mcp.capability';
  payload: { message?: string; [key: string]: unknown };
}

export interface McpToolEvent extends BaseTaskEvent {
  type: 'mcp.tool';
  payload: { tool?: string; status?: string; message?: string; [key: string]: unknown };
}

export interface WarningEvent extends BaseTaskEvent {
  type: 'warning';
  payload: { message: string; code?: string; [key: string]: unknown };
}

export interface ProviderTelemetryEvent extends BaseTaskEvent {
  type: 'provider.telemetry';
  payload: { [key: string]: unknown };
}

export interface ProjectOnboardingEvent extends BaseTaskEvent {
  type: 'project.onboarding';
  payload: { [key: string]: unknown };
}

// ----------------------------------------------------------------------------
// Discriminated TaskEvent Union (No generic catch-all)
// ----------------------------------------------------------------------------

export type TaskEvent =
  | TaskStartedEvent
  | TaskStateEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskErrorEvent
  | TaskRecoveryEvent
  | TaskRecoveryRequiredEvent
  | TaskRetryEvent
  | TaskSteerEvent
  | TaskContinuationEvent
  | TaskDisputedEvent
  | TaskRepairProgressEvent
  | TaskRoutedEvent
  | TaskTakeoverLocalEvent
  | TaskModelTakeoverEvent
  | TaskProviderRecoveryEvent
  | AgentStartedEvent
  | AgentOutputEvent
  | AgentProgressEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | VerificationResultEvent
  | ReviewVerdictEvent
  | ReviewStartedEvent
  | ReviewCompletedEvent
  | ReviewFindingEvent
  | GitCommitEvent
  | GitPushEvent
  | GitRemoteEvent
  | GitBaselineRequiredEvent
  | CloudDispatchingEvent
  | CloudDispatchedEvent
  | CloudActivityEvent
  | CloudPlanReceivedEvent
  | CloudPlanApprovedEvent
  | CloudMessageSentEvent
  | CloudFeedbackSentEvent
  | CloudRepairRequestedEvent
  | CloudReviewedEvent
  | CloudCompletedEvent
  | CloudFailedEvent
  | CloudCancelledEvent
  | CloudPrImportedEvent
  | RoutingDecisionEvent
  | RoutingAdjustmentEvent
  | McpCapabilityEvent
  | McpToolEvent
  | WarningEvent
  | ProviderTelemetryEvent
  | ProjectOnboardingEvent;

export type TaskEventType = TaskEvent['type'];

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
