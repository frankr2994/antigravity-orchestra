import type { Store } from '../../db.js';
import { getGitStatus } from '../../git.js';
import { readAntigravityTranscript, readAntigravityUsage, readCodexUsage } from '../../observability.js';
import { isOrchestraInternalPath } from '../../projects.js';
import type { AgentName, RunMonitor, TaskEvent, TaskState } from '../../types.js';
import { parseJulesAutomationStatus, type JulesAutomationState } from '../../domain/index.js';

export interface TaskRunState {
  isRunning(taskId: string): boolean;
}

export async function buildRunMonitor(store: Store, runs: TaskRunState, taskId: string): Promise<RunMonitor> {
  const task = store.getTask(taskId);
  if (!task) throw new Error('Task not found.');
  const project = store.getProject(task.projectId);
  if (!project) throw new Error('Project not found.');
  const events = store.listEvents(taskId);
  const now = Date.now();
  const lastEvent = events.at(-1);
  const stateEvent = events.findLast((event) => event.type === 'task.state' && String((event.payload as Record<string, unknown>).state) === task.state);
  const reviewEvent = events.findLast((event) => event.type === 'agent.started' && (event.payload as Record<string, unknown>).role === 'review');
  const repairEvent = events.findLast((event) => event.type === 'task.repair-progress');
  const cloud = task.target === 'cloud' ? store.manager.cloudSessions.getByTaskId(task.id) : null;
  const providerState = cloud?.state ?? null;
  const automationCheckpoint = cloud ? store.manager.checkpoints.latest(taskId, 'jules_automation') : null;
  let automationState: JulesAutomationState | null = null;
  let automationCorrupt = false;
  try { automationState = automationCheckpoint ? parseJulesAutomationStatus(automationCheckpoint.data).state : null; }
  catch { automationCorrupt = true; }
  const cloudActive = Boolean(cloud && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(cloud.state));
  const handoffPending = Boolean(cloud && cloud.state === 'COMPLETED' && task.target === 'cloud' && ['running', 'reviewing', 'verifying', 'committing', 'pushing'].includes(task.state));
  const latestReviewProgress = events.findLast((event) => event.type === 'cloud.reviewing');
  const handoffBusy = Boolean(handoffPending && latestReviewProgress && now - Date.parse(latestReviewProgress.createdAt) < 90_000);
  // A task-owned foreground heartbeat is emitted from the same awaited
  // Antigravity turn.  Scheduling/process inspection can briefly lag that
  // turn on Windows, so do not present a fresh heartbeat as a dead worker.
  const foregroundHeartbeat = hasRecentForegroundHeartbeat(events, now);
  const processAlive = runs.isRunning(taskId) || cloudActive || handoffBusy || foregroundHeartbeat;
  const durableActivityTimes = [cloud?.lastActivityAt, lastEvent?.createdAt, task.updatedAt].filter((value): value is string => Boolean(value));
  const lastActivityAt = durableActivityTimes.sort((left, right) => Date.parse(right) - Date.parse(left))[0] || task.updatedAt;
  const inactiveMs = Math.max(0, now - Date.parse(lastActivityAt));
  let changedFiles: string[] = [];
  try { changedFiles = (await getGitStatus(project.root)).files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path)); } catch { /* Monitoring must not alter task execution. */ }
  const providerNeedsAttention = Boolean(providerState && ['AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'PAUSED'].includes(providerState)
    && (automationCorrupt || automationState === 'blocked'));
  const health = task.state === 'paused' || providerNeedsAttention ? 'needs_attention'
    : handoffPending && !handoffBusy ? 'waiting'
    : evaluateRunHealth(task.state, processAlive, inactiveMs);
  const currentAgent = cloud && ['queued', 'preflight', 'running'].includes(task.state) ? 'jules' : agentForState(task.state);
  const reviewCycle = Number((reviewEvent?.payload as Record<string, unknown> | undefined)?.cycle || 0);
  const repairAttempt = Number((repairEvent?.payload as Record<string, unknown> | undefined)?.attempt || 0);
  const session = store.getSession(task.sessionId);
  const [codexAccount, antigravityAccount] = await Promise.all([readCodexUsage(), readAntigravityUsage()]);
  const codexUsage = mergeProviderTelemetry(codexAccount, latestProviderTelemetry(events, 'codex'));
  const antigravityUsage = mergeProviderTelemetry(antigravityAccount, latestProviderTelemetry(events, 'antigravity'));
  const antigravityMatchesProject = !antigravityUsage.workspace || antigravityUsage.workspace.replaceAll('\\', '/').toLowerCase() === project.root.replaceAll('\\', '/').toLowerCase();
  const summary = cloud
    ? cloudMonitorSummary(task.state, providerState, inactiveMs, Boolean(cloud.prUrl), repairAttempt)
    : monitorSummary({ state: task.state, health, currentAgent, inactiveMs, reviewCycle, repairAttempt, changedFiles: changedFiles.length });
  return {
    taskId,
    state: task.state,
    health,
    currentAgent,
    phaseStartedAt: stateEvent?.createdAt || task.updatedAt,
    lastActivityAt,
    elapsedMs: Math.max(0, now - Date.parse(task.createdAt)),
    inactiveMs,
    processAlive,
    providerState,
    progressDetail: cloud ? cloudProgressDetail(task.state, providerState, Boolean(cloud.prUrl), automationState, automationCorrupt) : summary,
    nextAction: taskNextAction(task.state, providerState, automationState, automationCorrupt),
    reviewCycle,
    repairAttempt,
    changedFiles,
    summary,
    stopReason: ['paused', 'recovery_required', 'review_disputed', 'failed', 'cancelled'].includes(task.state) ? task.error : null,
    providerTelemetry: { antigravity: antigravityMatchesProject ? antigravityUsage : { available: false, reason: 'The latest Antigravity snapshot belongs to another project.' }, codex: codexUsage },
    providerActivity: cloud
      ? events.filter((event) => event.agent === 'jules' || event.type.startsWith('cloud.')).slice(-50).map((event) => ({ agent: event.agent, type: event.type, createdAt: event.createdAt, payload: event.payload }))
      : readAntigravityTranscript(session?.antigravityConversationId || antigravityUsage.conversationId || null),
  };
}

export function evaluateRunHealth(state: TaskState, processAlive: boolean, inactiveMs: number): RunMonitor['health'] {
  if (state === 'completed' || state === 'completed_unpushed') return 'complete';
  if (state === 'paused' || state === 'recovery_required' || state === 'baseline_required' || state === 'review_disputed') return 'needs_attention';
  if (state === 'failed' || state === 'cancelled') return 'failed';
  if (!processAlive || inactiveMs >= 5 * 60_000) return 'possibly_stalled';
  if (inactiveMs >= 90_000) return 'waiting';
  return 'active';
}

export function hasRecentForegroundHeartbeat(events: readonly TaskEvent[], now = Date.now()): boolean {
  const event = events.findLast((item) => item.agent === 'antigravity' && item.type === 'agent.output'
    && typeof (item.payload as Record<string, unknown> | undefined)?.text === 'string'
    && /still working in the foreground/i.test(String((item.payload as Record<string, unknown>).text)));
  return Boolean(event && now - Date.parse(event.createdAt) < 90_000);
}

function latestProviderTelemetry(events: TaskEvent[], agent: 'antigravity' | 'codex'): Record<string, any> | null {
  const event = events.findLast((item) => item.agent === agent && item.type === 'provider.telemetry');
  return event?.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : null;
}

function mergeProviderTelemetry(account: Record<string, any>, live: Record<string, any> | null) {
  if (!live) return account;
  const turnUsage = live.usage && typeof live.usage === 'object' ? live.usage as Record<string, number> : null;
  return {
    ...account,
    available: account.available || Boolean(live.context || turnUsage),
    context: live.context || account.context,
    threadId: live.threadId,
    turnId: live.turnId,
    reroute: live.reroute,
    tokenActivity: turnUsage ? { ...(account.tokenActivity || {}), ...turnUsage } : account.tokenActivity,
  };
}

function agentForState(state: TaskState): AgentName {
  if (state === 'paused') return 'system';
  if (state === 'reviewing') return 'codex';
  if (state === 'running' || state === 'recovering') return 'antigravity';
  if (state === 'verifying') return 'verification';
  if (state === 'summarizing') return 'gemma';
  if (state === 'committing' || state === 'pushing') return 'git';
  return 'system';
}

export function taskNextAction(state: TaskState, providerState: string | null, automationState: JulesAutomationState | null, automationCorrupt: boolean): string | null {
  if (automationCorrupt) return 'Inspect the malformed durable automation checkpoint; Orchestra will not authorize an automatic action from it.';
  if (automationState === 'blocked') return 'Review the reported credential, destructive-operation, or authority blocker.';
  if (providerState === 'AWAITING_PLAN_APPROVAL') return 'No manual action is needed. Orchestra is reviewing the exact Jules plan automatically.';
  if (providerState === 'AWAITING_USER_FEEDBACK' || providerState === 'PAUSED') return 'No manual action is needed. Orchestra is resolving the latest Jules handoff and will confirm later provider activity.';
  if (providerState === 'COMPLETED' && ['running', 'reviewing', 'verifying', 'committing', 'pushing'].includes(state)) return 'Keep this task open; Orchestra is reviewing or retrying the exact PR handoff automatically.';
  if (state === 'paused') return 'Select Resume to continue this task with its preserved state.';
  if (state === 'recovery_required') return 'Select Resume to continue the preserved implementation through review and verification.';
  if (state === 'review_disputed') return 'Resolve the reported Git or pull-request safety issue. If local changes are preserved, use Commit & Push Changes.';
  if (state === 'completed_unpushed') return 'Retry the push after checking the upstream branch and credentials.';
  if (state === 'failed') return 'Open the error details, then retry from a clean state or resume preserved changes.';
  return null;
}

export function cloudProgressDetail(taskState: TaskState, providerState: string | null, hasPr: boolean, automationState: JulesAutomationState | null, automationCorrupt: boolean): string {
  if (taskState === 'reviewing') return hasPr ? 'The Jules PR is being fetched into an isolated local worktree for deterministic checks and independent review.' : 'Jules finished; Orchestra is waiting for a verified pull-request output before local review.';
  if (taskState === 'verifying') return 'The exact Jules PR head is running the project verification suite in an isolated worktree.';
  if (taskState === 'pushing' || taskState === 'committing') return 'The reviewed PR head is being integrated into the verified target branch.';
  if (providerState === 'QUEUED') return 'Jules accepted the session and is waiting for cloud capacity.';
  if (providerState === 'PLANNING') return 'Jules is inspecting the repository and building its implementation plan.';
  if (automationCorrupt) return 'Jules needs attention, but the persisted automation state is malformed and cannot authorize a response.';
  if (automationState === 'blocked') return 'Jules requested credentials, destructive action, or authority outside the original task; Orchestra failed closed.';
  if (providerState === 'AWAITING_PLAN_APPROVAL') return 'Jules produced a plan. Orchestra is reviewing and approving or correcting it automatically.';
  if (providerState === 'AWAITING_USER_FEEDBACK') return automationState === 'awaiting_provider_resume'
    ? 'Orchestra answered the latest Jules clarification and is waiting for later agent activity before declaring resumption.'
    : 'Orchestra is resolving the latest Jules clarification automatically.';
  if (providerState === 'PAUSED') return automationState === 'awaiting_provider_resume'
    ? 'Orchestra sent bounded resume guidance and is waiting for later Jules agent activity.'
    : 'Orchestra is resolving the remote pause automatically.';
  if (providerState === 'IN_PROGRESS') return 'Jules is implementing and testing in its cloud workspace. New provider activities appear below.';
  if (providerState === 'COMPLETED') return 'Jules execution completed; Orchestra owns the remaining local review and integration stages.';
  if (providerState === 'FAILED') return 'Jules reported a provider failure. The durable task record remains available for diagnosis.';
  if (providerState === 'CANCELLED') return 'The Jules session was deleted and its local capacity reservation was released.';
  return 'Orchestra is reconciling the Jules provider state.';
}

function cloudMonitorSummary(state: TaskState, providerState: string | null, inactiveMs: number, hasPr: boolean, repairAttempt: number): string {
  const activity = inactiveMs < 60_000 ? `${Math.round(inactiveMs / 1000)} seconds` : `${Math.round(inactiveMs / 60_000)} minutes`;
  const repair = repairAttempt ? ` ${repairAttempt} Jules repair request${repairAttempt === 1 ? '' : 's'} recorded.` : '';
  return `Jules is ${String(providerState || 'being reconciled').replaceAll('_', ' ').toLowerCase()}; Orchestra is ${state.replaceAll('_', ' ')}. Last durable activity was ${activity} ago.${hasPr ? ' A pull request is attached.' : ''}${repair}`;
}

function monitorSummary(input: { state: TaskState; health: RunMonitor['health']; currentAgent: AgentName; inactiveMs: number; reviewCycle: number; repairAttempt: number; changedFiles: number }) {
  const activity = input.inactiveMs < 60_000 ? `${Math.round(input.inactiveMs / 1000)} seconds` : `${Math.round(input.inactiveMs / 60_000)} minutes`;
  const cycle = input.reviewCycle ? ` Review cycle ${input.reviewCycle}.` : '';
  const repair = input.repairAttempt ? ` ${input.repairAttempt} automatic repair attempt${input.repairAttempt === 1 ? '' : 's'} completed.` : '';
  return `${input.currentAgent} is in ${input.state.replaceAll('_', ' ')}. Last activity was ${activity} ago. Health: ${input.health.replaceAll('_', ' ')}.${cycle}${repair} ${input.changedFiles} uncommitted project file${input.changedFiles === 1 ? '' : 's'} detected.`;
}
