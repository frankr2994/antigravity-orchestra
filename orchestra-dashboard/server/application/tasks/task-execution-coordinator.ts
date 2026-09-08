import type { Store } from '../../db.js';
import type { AgentName, ModelSelection, Project, RunMonitor, TaskClassification, TaskEvent, TaskRecord, TaskState } from '../../types.js';
import { type TaskEventType } from '../../domain/index.js';
import { ProjectTaskScheduler } from './project-task-scheduler.js';
import { ProjectTaskOwnershipService } from './project-task-ownership-service.js';
import { TaskEventPublisher } from './task-event-publisher.js';
import { GitFinalizationService } from '../git/git-finalization-service.js';
import { createHash } from 'node:crypto';
import {
  classifyTask,
  listAntigravityModels,
  runAntigravity,
  runCodexAnalysis,
  selectModels,
  type AgentRunResult,
} from '../../agents.js';
import { collectRepositoryEvidence } from '../../evidence.js';
import { connectGitHubRemote, extractGitHubRemoteUrl, getGitStatus, pushCurrent } from '../../git.js';
import { initializeGreenfieldRepository, isOrchestraInternalPath, onboardProject } from '../../projects.js';
import { getMcpStatus, type McpStatus } from '../../mcp.js';
import { ApplicationError } from '../errors.js';
import { ProviderRunRecorder } from '../usage/provider-run-recorder.js';
import { buildRunMonitor } from './run-monitor-service.js';
import type { JulesBuilderPort } from './jules-builder-port.js';
import { TaskControlService } from './task-control-service.js';
import { DirectTaskExecutor } from './direct-task-executor.js';
import { TaskConversationContext } from './task-conversation-context.js';

import {
  runSensingStage,
  runRefinementStage,
  runArchitectStage,
  runSizingStage,
  runBuilderStage,
  runVerificationStage,
  runReviewAuditStage,
  runFinalizationStage,
  type PipelineContext,
} from './pipeline/index.js';

export interface CodexCapacityRetry {
  version: 1;
  attempts: number;
  retryAt: string;
  reason: string;
}

/** A provider capacity response is retryable, unlike an implementation failure. */
export function isCodexCapacityFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return /usage limit|quota|credits|rate limit|at capacity|overloaded|try again at/i.test(message);
}

/** Validates the persisted wake-up record before it can restart a workflow. */
export function parseCodexCapacityRetry(value: unknown): CodexCapacityRetry | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !Number.isSafeInteger(data.attempts) || Number(data.attempts) < 1 ||
      typeof data.retryAt !== 'string' || !Number.isFinite(Date.parse(data.retryAt)) ||
      typeof data.reason !== 'string') return null;
  return { version: 1, attempts: Number(data.attempts), retryAt: data.retryAt, reason: data.reason };
}

export function codexCapacityRetryDelay(attempts: number): number {
  return Math.min(15 * 60_000, 60_000 * (2 ** Math.min(Math.max(0, attempts), 4)));
}

export class TaskExecutionCoordinator {
  readonly events: TaskEventPublisher;
  readonly scheduler: ProjectTaskScheduler;
  readonly ownership: ProjectTaskOwnershipService;
  readonly taskControls: TaskControlService;
  gitFinalization: GitFinalizationService;
  readonly directTasks: DirectTaskExecutor;
  readonly conversationContext: TaskConversationContext;
  private readonly manualCommits = new Set<string>();
  private readonly controlRequests = new Map<string, 'pause' | 'stop'>();
  private antigravityModels: string[] = [];
  private julesBuilder?: JulesBuilderPort;
  private readonly capacityRetryTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly store: Store, maxGlobal = 2) {
    const providerRuns = new ProviderRunRecorder(store);
    this.events = new TaskEventPublisher(store, (event) => providerRuns.observe(event));
    this.scheduler = new ProjectTaskScheduler(store, (taskId, signal) => this.execute(taskId, signal), maxGlobal);
    this.taskControls = new TaskControlService(store, this.scheduler, this.controlRequests,
      (taskId, agent, type, payload) => this.emit(taskId, agent, type, payload as Record<string, unknown>));
    this.ownership = new ProjectTaskOwnershipService(store, this.scheduler,
      (taskId, type, payload) => this.emit(taskId, 'system', type, payload as Record<string, unknown>));
    this.gitFinalization = new GitFinalizationService(store);
    this.directTasks = new DirectTaskExecutor(store, {
      transition: (taskId, state) => this.transition(taskId, state),
      emit: (taskId, agent, type, payload) => this.emit(taskId, agent, type, payload as Record<string, unknown>),
      complete: (taskId, result, agent) => this.complete(taskId, result, agent),
      stream: (taskId, agent, chunk) => this.stream(taskId, agent, chunk),
      recordProviderTelemetry: (taskId, agent, value) => this.recordProviderTelemetry(taskId, agent, value),
      recordLocalProviderTelemetry: (taskId, usage) => this.recordLocalProviderTelemetry(taskId, usage),
    });
    this.conversationContext = new TaskConversationContext(store,
      (taskId, agent, type, payload) => this.emit(taskId, agent, type, payload as Record<string, unknown>));
    void this.refreshModels();
  }

  configureJulesBuilder(builder: JulesBuilderPort) { this.julesBuilder = builder; }

  async refreshModels() { this.antigravityModels = await listAntigravityModels(); }
  enqueue(taskId: string) { this.scheduler.enqueue(taskId); }
  subscribe(taskId: string, listener: (event: TaskEvent) => void) { return this.events.subscribe(taskId, listener); }
  pause(taskId: string) { return this.taskControls.pause(taskId); }
  resume(taskId: string) { return this.taskControls.resume(taskId); }
  cancel(taskId: string) { return this.taskControls.stop(taskId); }

  async recover(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    return this.resumePreservedTask(task);
  }

  /**
   * Resume a capacity-paused local workflow without requiring a dirty tree.
   * Capacity can be hit before the builder changes files, so the ordinary
   * preserved-work recovery gate would otherwise strand an automatic route.
   */
  async resumeAfterCodexCapacity(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.target !== 'local' || task.state !== 'recovery_required') {
      throw new ApplicationError('CODEX_CAPACITY_RETRY_NOT_PENDING', 'This task is not waiting for a local Codex capacity retry.', 409);
    }
    const checkpoint = this.store.manager.checkpoints.latest(taskId, 'codex_capacity_retry');
    if (!checkpoint || !parseCodexCapacityRetry(checkpoint.data)) {
      throw new ApplicationError('CODEX_CAPACITY_RETRY_INVALID', 'The persisted Codex capacity retry state is malformed.', 409);
    }
    this.transition(task.id, 'recovering');
    this.emit(task.id, 'system', 'task.resumed', {
      message: 'Codex capacity retry window reached. Resuming the same local workflow automatically.',
      source: 'codex_capacity_retry',
    });
    if (this.scheduler.isRunning(task.id)) this.scheduler.enqueueAfterCurrent(task.id);
    else this.enqueue(task.id);
    return requireTask(this.store, task.id);
  }

  private async resumePreservedTask(task: TaskRecord): Promise<TaskRecord> {
    const disposition = recoveryDisposition(task.state, this.scheduler.isRunning(task.id));
    if (disposition === 'already_active') return task;
    if (disposition === 'reject') {
      throw new ApplicationError('TASK_NOT_RECOVERABLE', 'Only a failed or recovery-required task with preserved changes can be resumed.', 409);
    }
    const project = requireProject(this.store, task.projectId);
    const classification = parseTaskClassification(task.classification);
    const status = await getGitStatus(project.root);
    const recoverableFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (!classification?.mutating || !status.isGit || !recoverableFiles.length) {
      throw new ApplicationError('TASK_HAS_NO_RECOVERABLE_CHANGES', 'This task has no recoverable uncommitted implementation changes.', 409);
    }
    this.transition(task.id, 'recovering');
    this.emit(task.id, 'system', 'task.recovery', {
      message: 'Resuming the failed task with its preserved uncommitted changes.',
    });
    if (this.scheduler.isRunning(task.id)) this.scheduler.enqueueAfterCurrent(task.id);
    else this.enqueue(task.id);
    return requireTask(this.store, task.id);
  }

  async retry(taskId: string) {
    const task = requireTask(this.store, taskId);
    if (task.state !== 'failed') throw new ApplicationError('TASK_NOT_RETRYABLE', 'Only a failed task can be retried from a clean project state.', 409);
    if (this.activeTaskId(task.projectId)) throw new ApplicationError('PROJECT_TASK_ACTIVE', 'Another task already owns this project.', 409);
    const project = requireProject(this.store, task.projectId);
    const classification = parseTaskClassification(task.classification);
    const status = await getGitStatus(project.root);
    const projectFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (classification?.mutating && projectFiles.length) {
      throw new ApplicationError('TASK_RETRY_HAS_PRESERVED_CHANGES', 'This failed task has uncommitted changes.', 409);
    }
    this.store.updateTask(taskId, { state: 'queued', error: null });
    this.emit(taskId, 'system', 'task.state', { state: 'queued' });
    this.enqueue(taskId);
  }

  async commitUncommittedChanges(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.state === 'completed' || task.state === 'completed_unpushed') return task;
    const allowedStates: TaskState[] = ['baseline_required', 'paused', 'recovery_required', 'review_disputed', 'failed'];
    if (!allowedStates.includes(task.state)) {
      throw new ApplicationError('TASK_STILL_RUNNING', `This task is ${task.state.replaceAll('_', ' ')}. Stop or pause it before committing its working changes.`, 409,
        { nextAction: 'Stop or pause the task, then use Commit & Push Changes.', retryable: true });
    }
    if (task.target === 'cloud') {
      throw new ApplicationError('LOCAL_CHANGES_REQUIRED', 'Cloud tasks do not own an uncommitted local working tree.', 409,
        { nextAction: 'Use the Jules task panel for the remote pull request.', retryable: false });
    }
    if (this.manualCommits.has(taskId)) {
      throw new ApplicationError('COMMIT_IN_PROGRESS', 'These changes are already being committed.', 409,
        { nextAction: 'Wait for the current commit to finish.', retryable: true });
    }
    this.manualCommits.add(taskId);
    try {
      await this.scheduler.waitForExit(taskId);
      const project = requireProject(this.store, task.projectId);
      const finalized = await this.gitFinalization.finalize(
        taskId,
        project,
        task.prompt,
        (state) => this.transition(taskId, state),
        (agent, type, payload) => this.emit(taskId, agent, type, payload as any),
        { simple: true }
      );
      if (finalized.status === 'skipped') {
        const message = finalized.reason === 'not_git'
          ? 'This project is not a Git repository.'
          : 'There are no uncommitted project changes to commit.';
        throw new ApplicationError(
          finalized.reason === 'not_git' ? 'PROJECT_NOT_GIT' : 'NO_UNCOMMITTED_CHANGES',
          message,
          409,
          { nextAction: finalized.reason === 'not_git'
            ? 'Initialize or restore Git before committing.'
            : 'Refresh the task; no empty commit was created.', retryable: false }
        );
      }
      this.complete(taskId, `Committed ${finalized.commitSha.slice(0, 8)}${finalized.pushStatus === 'pushed' ? ' and pushed it to the current upstream branch.' : '. The commit is local because the push did not succeed.'}`, 'system');
      return requireTask(this.store, taskId);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      const message = 'Git could not commit the uncommitted changes. The files were left in place.';
      const latest = requireTask(this.store, taskId);
      if (['summarizing', 'committing', 'pushing'].includes(latest.state)) {
        this.store.updateTask(taskId, { state: task.state, error: message });
        this.emit(taskId, 'system', 'warning', {
          message,
          code: 'COMMIT_CHANGES_FAILED',
          detail: error instanceof Error ? error.message : String(error),
          nextAction: 'Correct the reported Git problem, then click Commit & Push Changes again.',
        });
      }
      throw new ApplicationError('COMMIT_CHANGES_FAILED', message, 409, {
        cause: error,
        nextAction: 'Correct the reported Git problem, then click Commit & Push Changes again.',
        retryable: true,
      });
    } finally {
      this.manualCommits.delete(taskId);
    }
  }

  async retryPush(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.state !== 'completed_unpushed') {
      throw new ApplicationError('TASK_NOT_UNPUSHED', 'Only an unpushed completed task can retry its push.', 409);
    }
    const project = requireProject(this.store, task.projectId);
    this.transition(taskId, 'pushing');
    const pushed = await pushCurrent(project.root);
    if (!pushed.pushed) {
      this.transition(taskId, 'completed_unpushed');
      throw new ApplicationError('PUSH_FAILED', pushed.error || 'Failed to push commit upstream.', 409);
    }
    this.store.updateTask(taskId, { pushStatus: 'pushed', state: 'completed' });
    this.emit(taskId, 'git', 'git.push', pushed);
    this.emit(taskId, 'system', 'task.state', { state: 'completed' });
    return requireTask(this.store, taskId);
  }

  async resumePreparedJulesTakeover(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    const checkpoint = this.store.manager.checkpoints.latest(taskId, 'local_takeover');
    if (task.target !== 'local' || task.state !== 'recovery_required' || !checkpoint || !['prepared', 'queued'].includes(String(checkpoint.data.status)) || !checkpoint.subjectSha) {
      throw new ApplicationError('JULES_TAKEOVER_NOT_PREPARED', 'This task does not have a prepared Jules local-repair takeover.', 409);
    }
    const existingAttempt = this.store.manager.attempts.listByTaskId(taskId).find((attempt) =>
      attempt.target === 'local' && attempt.worker === 'antigravity' && attempt.baseSha.toLowerCase() === checkpoint.subjectSha!.toLowerCase() && attempt.state === 'WORKING');
    const attempt = existingAttempt ?? this.store.manager.attempts.create({
      taskId,
      target: 'local',
      worker: 'antigravity',
      baseSha: checkpoint.subjectSha,
      branchName: typeof checkpoint.data.targetBranch === 'string' ? checkpoint.data.targetBranch : null,
      state: 'WORKING',
    });
    if (checkpoint.data.status === 'prepared') {
      this.store.manager.checkpoints.append({ taskId, attemptId: attempt.id, stage: 'local_takeover', subjectSha: checkpoint.subjectSha,
        data: { ...checkpoint.data, status: 'queued', localAttemptId: attempt.id } });
    }
    this.store.updateTask(taskId, { state: 'recovering' });
    this.emit(taskId, 'system', 'task.resumed', { message: 'The reviewed Jules PR head is local. Starting Antigravity repair.', source: 'jules_local_takeover' });
    this.enqueue(taskId);
    return requireTask(this.store, taskId);
  }

  activeTaskId(projectId: string) { return this.ownership.current(projectId)?.id ?? null; }
  activeTask(projectId: string): TaskRecord | null { return this.ownership.current(projectId); }
  reconcileProjectOwner(projectId: string): Promise<TaskRecord | null> { return this.ownership.reconcile(projectId); }
  async getMonitor(taskId: string): Promise<RunMonitor> { return buildRunMonitor(this.store, this.scheduler, taskId); }

  private async execute(taskId: string, signal: AbortSignal) {
    let task = requireTask(this.store, taskId);
    const recovery = task.state === 'recovering';
    const recoveryReason = recovery ? task.error : null;
    const project = requireProject(this.store, task.projectId);
    const session = this.store.getSession(task.sessionId);
    if (!session) return this.fail(taskId, 'Conversation not found.');

    try {
      if (recoveryReason) this.store.updateTask(taskId, { error: null });
      const initialTaskClassification = parseTaskClassification(task.classification);
      const originalClassification = recovery ? initialTaskClassification : null;

      let classified: { classification: TaskClassification; source: string; warning?: string };
      if (initialTaskClassification?.executionMode === 'direct') {
        classified = { classification: initialTaskClassification, source: 'direct' };
      } else if (originalClassification) {
        classified = { classification: originalClassification, source: 'recovery', warning: undefined };
      } else {
        classified = await classifyTask(task.prompt);
      }
      const classification = classified.classification;
      if (classified.warning) this.emit(taskId, 'gemma', 'warning', { message: `Gemma classification unavailable; deterministic routing was used. ${classified.warning}` });
      else if (classification.executionMode !== 'direct') this.emit(taskId, 'gemma', 'agent.completed', { phase: 'classification', classification, recovered: recovery });

      const direct = await this.directTasks.execute({ task, project, session, classification, signal });
      if (direct.handled) return;
      const activeGemmaModel = direct.activeGemmaModel;

      if (!recovery && classification.localOperation === 'connect_git_remote') {
        return this.handleConnectGitRemote(taskId, project, session, task, classification, activeGemmaModel);
      }

      // Stage 1: Sensing & Preflight (Dynamic, zero hardcoding)
      const sensing = await runSensingStage({
        taskId, project, classification, activeGemmaModel, antigravityModels: this.antigravityModels,
        recovery, store: this.store,
        emit: (agent, type, payload) => this.emit(taskId, agent, type, payload),
        transition: (state) => this.transition(taskId, state),
      });
      if (sensing.isBaselineRequired) {
        // Pre-existing uncommitted changes require an explicit baseline: Use Commit & Push Changes to commit them.
        return;
      }

      let status = await getGitStatus(project.root);
      if (!['ready', 'ready_unpushed', 'ready_non_git'].includes(project.onboardingStatus)) {
        const onboarding = await onboardProject(this.store, project);
        this.emit(taskId, 'system', 'project.onboarding', onboarding);
        status = await getGitStatus(project.root);
      }
      if (classification.mutating && !status.isGit) {
        const initialized = await initializeGreenfieldRepository(this.store, project);
        this.emit(taskId, 'system', 'project.onboarding', initialized);
        status = await getGitStatus(project.root);
        if (!status.isGit) throw new Error('File-changing tasks require a Git repository.');
      }

      let mcpStatus: McpStatus | null = null;
      try { mcpStatus = await getMcpStatus(); } catch { /* ignore */ }
      const riderFor = (agent: AgentName) => agent === 'antigravity' || agent === 'codex' || agent === 'gemma' ? Boolean(mcpStatus?.agents[agent]?.available) : false;

      // Non-mutating Question / Design Tasks
      if (!classification.mutating) {
        return this.handleQuestionTask(taskId, project, session, task, classification, sensing.models, riderFor, signal);
      }

      // Assemble Typed Pipeline Context
      const ctx: PipelineContext = {
        taskId, project, session, task, classification,
        models: sensing.models,
        capabilities: sensing.capabilities,
        status, signal, recovery,
        recoveryReason: recoveryReason ?? undefined,
        activeGemmaModel,
        antigravityModels: this.antigravityModels,
        refinedSpec: task.prompt,
        store: this.store,
        emit: (agent, type, payload) => this.emit(taskId, agent, type, payload),
        stream: (agent, chunk) => this.stream(taskId, agent, chunk),
        transition: (state) => this.transition(taskId, state),
        recordProviderTelemetry: (provider, usage) => this.recordProviderTelemetry(taskId, provider, usage),
        recordLocalProviderTelemetry: (usage) => this.recordLocalProviderTelemetry(taskId, usage),
        riderFor,
        julesBuilder: this.julesBuilder,
        complete: (result, agent) => this.complete(taskId, result, agent),
      };

      // Stage 2: Pre-Plan Prompt Refinement & Routing (Pass 1)
      const refinement = await runRefinementStage(ctx);
      ctx.refinedSpec = refinement.refinedSpec;

      // Stage 3: The Architect Blueprint (Single Pass)
      let blueprint = '';
      if (ctx.models.codex && ctx.models.codexEffort) {
        const architect = await runArchitectStage(ctx, refinement.refinedSpec, ctx.models.codex, ctx.models.codexEffort);
        blueprint = architect.blueprint;
      }

      // Stage 4: Post-Plan Construction Sizing (Pass 2)
      const sizing = await runSizingStage(ctx, blueprint, refinement.refinedSpec);

      // Stage 5: The Builder Execution (Antigravity / Jules / Both)
      const builder = await runBuilderStage({
        ctx,
        refinedSpec: refinement.refinedSpec,
        blueprint,
        builderTarget: refinement.routeTarget,
        antigravityModel: sizing.antigravityModel,
        antigravityEffort: sizing.antigravityEffort,
      });
      if (builder.builderTarget === 'jules' && builder.julesResult && !builder.julesResult.requiredLocalRepair) {
        ctx.complete(builder.agentResult.text, 'jules');
        return;
      }

      // Stage 6: Deterministic Verification & Change Inspection
      const takeover = this.store.manager.checkpoints.latest(taskId, 'local_takeover');
      const takeoverBaseSha = takeover && typeof takeover.data.baseSha === 'string' && /^[0-9a-f]{40}$/i.test(takeover.data.baseSha)
        ? takeover.data.baseSha
        : null;
      const reviewBaseSha = takeoverBaseSha || status.head;

      await runVerificationStage(ctx, reviewBaseSha);

      // Stage 7: Diff Condensation & Codex Auditor Review Gate
      const audit = await runReviewAuditStage(ctx, reviewBaseSha, builder.agentResult.text);
      if (!audit.passed) return;

      // Stage 8: Handoff Documentation, Git Finalization & Completion
      await runFinalizationStage(ctx, builder.agentResult.text, builder.hadIncompleteRun);
    } catch (error) {
      if (signal.aborted) {
        const req = this.controlRequests.get(taskId);
        if (req === 'pause') {
          this.transition(taskId, 'paused');
          this.emit(taskId, 'system', 'task.paused', { message: 'The task was paused by the user. You can resume it from the task dashboard.' });
          return;
        }
        this.transition(taskId, 'failed');
        this.emit(taskId, 'system', 'task.state', { state: 'failed' });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.deferCodexCapacityRetry(taskId, message)) return;
      this.fail(taskId, message);
    }
  }

  private async handleConnectGitRemote(taskId: string, project: Project, session: any, task: TaskRecord, classification: TaskClassification, activeGemmaModel: string) {
    const localModels: ModelSelection = { ...selectModels(classification), primary: 'gemma', gemma: activeGemmaModel, codex: null, codexEffort: null };
    this.store.updateTask(taskId, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(localModels) });
    this.transition(taskId, 'preflight');
    const remoteUrl = findRecentGitHubUrl(this.store, session.id, task.prompt);
    if (!remoteUrl) throw new Error('No valid HTTPS GitHub repository URL was found in recent conversation.');
    this.transition(taskId, 'running');
    this.emit(taskId, 'gemma', 'agent.started', { phase: 'local-operation', operation: 'connect_git_remote', model: activeGemmaModel });
    const connected = await connectGitHubRemote(project.root, remoteUrl);
    this.store.updateTask(taskId, { commitSha: connected.head, pushStatus: 'pushed' });
    this.store.createGitOperation(project.id, taskId, 'connect_remote', connected.head, connected.branch, 'pushed', null);
    this.emit(taskId, 'git', 'git.remote', connected);
    this.emit(taskId, 'git', 'git.push', { pushed: true, remote: connected.remote, branch: connected.branch });
    this.emit(taskId, 'gemma', 'agent.completed', { phase: 'local-operation', operation: 'connect_git_remote' });
    this.complete(taskId, `Connected this project to ${connected.remote} as \`origin\` and pushed \`${connected.branch}\` at commit \`${connected.head}\`.`, 'gemma');
  }

  private async handleQuestionTask(taskId: string, project: Project, session: any, task: TaskRecord, classification: TaskClassification, models: ModelSelection, riderFor: any, signal: AbortSignal) {
    const sessionContext = await this.conversationContext.prepare(taskId, session);
    let specialistContext = '';
    if (classification.codexRole !== 'none' && models.codex && models.codexEffort) {
      this.transition(taskId, 'reviewing');
      this.emit(taskId, 'codex', 'agent.started', { role: classification.codexRole, model: models.codex, effort: models.codexEffort });
      specialistContext = await runCodexAnalysis({
        root: project.root, prompt: task.prompt, role: classification.codexRole, model: models.codex, effort: models.codexEffort,
        riderAvailable: riderFor('codex'), signal,
        onOutput: (chunk) => this.stream(taskId, 'codex', chunk),
        onUsage: (usage) => this.recordProviderTelemetry(taskId, 'codex', usage),
      });
      this.emit(taskId, 'codex', 'agent.completed', { role: classification.codexRole, summary: specialistContext.slice(-4000) });
    }

    this.transition(taskId, 'running');
    this.emit(taskId, 'antigravity', 'agent.started', { phase: 'implementation', model: models.antigravity, effort: models.antigravityEffort });
    const agentResult = await runAntigravity({
      root: project.root, prompt: task.prompt, model: models.antigravity, effort: models.antigravityEffort || 'high',
      mutating: false, conversationId: session.antigravityConversationId,
      context: specialistContext, sessionContext, riderAvailable: riderFor('antigravity'), signal,
      onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk),
      onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage),
    });

    if (agentResult.conversationId) this.store.setConversationId(session.id, agentResult.conversationId);
    this.emit(taskId, 'antigravity', 'agent.completed', { summary: agentResult.text.slice(-5000) });

    const evidence = collectRepositoryEvidence(project.root, task.prompt);
    const validatedResult = await this.conversationContext.validate(taskId, project.root, task.prompt, agentResult.text, evidence);
    this.complete(taskId, validatedResult, 'antigravity');
  }

  private transition(taskId: string, state: TaskState) {
    this.store.updateTask(taskId, { state });
    this.emit(taskId, 'system', 'task.state', { state });
  }

  private emit(taskId: string, agent: AgentName, type: TaskEventType, payload?: Record<string, unknown>) {
    this.events.publish(taskId, agent, type, payload);
  }

  private stream(taskId: string, agent: AgentName, chunk: string) {
    const cleaned = chunk.trim();
    if (cleaned) this.emit(taskId, agent, 'agent.output', { text: cleaned.slice(-4000) });
  }

  private complete(taskId: string, result: string, agent: AgentName) {
    const task = requireTask(this.store, taskId);
    const state: TaskState = task.pushStatus === 'unpushed' ? 'completed_unpushed' : 'completed';
    this.store.updateTask(taskId, { state, result });
    for (const attempt of this.store.manager.attempts.listByTaskId(taskId)) {
      if (attempt.target === 'local' && attempt.state === 'WORKING') {
        this.store.manager.attempts.update(attempt.id, { state: 'COMPLETED', headSha: task.commitSha, completedAt: new Date().toISOString() });
      }
    }
    this.store.addMessage({ sessionId: task.sessionId, taskId, role: 'assistant', agent, content: result || 'Task completed.' });
    this.emit(taskId, 'system', 'task.state', { state, result });
  }

  private fail(taskId: string, error: string) {
    this.store.updateTask(taskId, { state: 'failed', error });
    for (const attempt of this.store.manager.attempts.listByTaskId(taskId)) {
      if (attempt.target === 'local' && attempt.state === 'WORKING') {
        this.store.manager.attempts.update(attempt.id, { state: 'FAILED', error: error.slice(0, 4_000), completedAt: new Date().toISOString() });
      }
    }
    this.emit(taskId, 'system', 'task.error', { error });
    this.emit(taskId, 'system', 'task.state', { state: 'failed' });
  }

  private deferCodexCapacityRetry(taskId: string, message: string): boolean {
    if (!isCodexCapacityFailure(message)) return false;
    const task = this.store.getTask(taskId);
    if (!task || task.target !== 'local') return false;
    const latest = this.store.manager.checkpoints.latest(taskId, 'codex_capacity_retry');
    const previous = latest ? parseCodexCapacityRetry(latest.data) : null;
    const attempts = previous?.attempts ?? 0;
    const delayMs = codexCapacityRetryDelay(attempts);
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    this.store.manager.checkpoints.append({ taskId, stage: 'codex_capacity_retry', data: {
      version: 1, attempts: attempts + 1, retryAt, reason: message.slice(0, 2_000),
    } });
    this.store.updateTask(taskId, { state: 'recovery_required', error: `Codex capacity is unavailable; Orchestra will resume automatically after ${Math.ceil(delayMs / 60_000)} minute(s).` });
    this.emit(taskId, 'system', 'warning', { provider: 'codex', retryAt, attempts: attempts + 1,
      message: 'Codex capacity is unavailable. The preserved local changes will be retried automatically without a user prompt.' });
    const previousTimer = this.capacityRetryTimers.get(taskId);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      this.capacityRetryTimers.delete(taskId);
      void this.resumeAfterCodexCapacity(taskId).catch((caught) => this.fail(taskId, caught instanceof Error ? caught.message : String(caught)));
    }, delayMs);
    timer.unref();
    this.capacityRetryTimers.set(taskId, timer);
    return true;
  }

  private recordProviderTelemetry(taskId: string, provider: string, usage: unknown) {
    if (!usage || typeof usage !== 'object') return;
    this.emit(taskId, provider as AgentName, 'provider.telemetry', usage as Record<string, unknown>);
  }

  private recordLocalProviderTelemetry(taskId: string, usage: unknown) {
    if (!usage || typeof usage !== 'object') return;
    this.emit(taskId, 'gemma', 'provider.telemetry', usage as Record<string, unknown>);
  }
}

export { evaluateRunHealth, hasRecentForegroundHeartbeat } from './run-monitor-service.js';

export function recoveryDisposition(state: TaskState, taskAlreadyOwnsProject: boolean): 'start' | 'already_active' | 'reject' {
  if (state === 'failed' || state === 'recovery_required') return 'start';
  if (taskAlreadyOwnsProject) return 'already_active';
  return 'reject';
}

export function providerFailureStatus(reason: string): 'IDLE_TIMEOUT' | 'TIMEOUT' | 'PROCESS_ERROR' {
  if (/no stream activity|produced no output|stalled process/i.test(reason)) return 'IDLE_TIMEOUT';
  return /timed?\s*out|timeout|exceeded/i.test(reason) ? 'TIMEOUT' : 'PROCESS_ERROR';
}

export function providerFailoverDisposition(changedFileCount: number): 'review_preserved_diff' | 'diagnose_and_retry' {
  return changedFileCount > 0 ? 'review_preserved_diff' : 'diagnose_and_retry';
}

export function reviewFingerprint(review: string) {
  const findings = review.split(/\r?\n/).map((line) => line.trim().toLowerCase())
    .filter((line) => /^([-*]|\d+\.)\s*(critical|high|medium|low|p[0-3]|\[p[0-3]\])/i.test(line))
    .map((line) => line.replace(/:\d+/g, ':#').replace(/\s+/g, ' '));
  return createHash('sha256').update(findings.join('\n') || review.replace(/\s+/g, ' ').toLowerCase()).digest('hex');
}

export function implementationChangeState(beforeHead: string | null, after: { head: string | null; files: Array<{ path: string }> }) {
  if (after.files.some((file) => !isOrchestraInternalPath(file.path))) return 'working_tree' as const;
  if (beforeHead && after.head && beforeHead !== after.head) return 'committed' as const;
  return 'none' as const;
}

export function hasReviewablePreservedProviderOutput(result: Pick<AgentRunResult, 'incomplete' | 'text'>, changedFileCount: number) {
  return Boolean(result.incomplete && changedFileCount > 0 && result.text && result.text.trim());
}

function requireTask(store: Store, taskId: string): TaskRecord {
  const task = store.getTask(taskId);
  if (!task) throw new ApplicationError('TASK_NOT_FOUND', 'Task not found.', 404);
  return task;
}

function requireProject(store: Store, projectId: string): Project {
  const project = store.getProject(projectId);
  if (!project) throw new ApplicationError('PROJECT_NOT_FOUND', 'Project not found.', 404);
  return project;
}

function parseTaskClassification(value?: string | null): TaskClassification | null {
  if (!value) return null;
  try { return JSON.parse(value) as TaskClassification; } catch { return null; }
}

function findRecentGitHubUrl(store: Store, sessionId: string, fallbackPrompt: string): string | null {
  const direct = extractGitHubRemoteUrl(fallbackPrompt);
  if (direct) return direct;
  const messages = store.listMessages(sessionId);
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - 30); index -= 1) {
    const found = extractGitHubRemoteUrl(messages[index].content);
    if (found) return found;
  }
  return null;
}
