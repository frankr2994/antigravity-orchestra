import { createHash } from 'node:crypto';
import { config } from './config.js';
import type { Store } from './db.js';
import type { AgentName, ModelSelection, Project, RunMonitor, Session, TaskClassification, TaskEvent, TaskRecord, TaskState } from './types.js';
import { isGemmaMicroEditCandidate, type TaskEventType } from './domain/index.js';
import { ProjectTaskScheduler } from './application/tasks/project-task-scheduler.js';
import { ProjectTaskOwnershipService } from './application/tasks/project-task-ownership-service.js';
import { TaskEventPublisher } from './application/tasks/task-event-publisher.js';
import { GitFinalizationService } from './application/git/git-finalization-service.js';
export { appendHandoff } from './application/git/handoff.js';
import { answerRepositoryQuestion, buildReviewPacket, classifyTask, distillVerificationErrors, extractCodexReviewVerdict, getActiveLmStudioModel, listAntigravityModels, preReviewSanityCheck, resolveAntigravityModel, runAntigravity, runCodexAnalysis, runCodexReview, runGemmaDirectChat, selectModels, selectReviewProfile, shouldAttemptGemmaAnswer, summarizeConversation, triageProviderFailure, triageReview, validateAgentResponse, type AgentRunResult, type ProviderFailureTriage, type ReviewTriage } from './agents.js';
import { collectRepositoryEvidence, type RepositoryEvidence } from './evidence.js';
import { connectGitHubRemote, extractGitHubRemoteUrl, getChangedFilesFromBase, getDiff, getDiffFromBase, getGitStatus, getRecentCommits } from './git.js';
import { initializeGreenfieldRepository, isOrchestraInternalPath, onboardProject } from './projects.js';
import { verificationFailure as describeVerificationFailure, verifyProject } from './verification.js';
import { readAntigravityUsage } from './observability.js';
import { getMcpStatus, type McpStatus } from './mcp.js';
import { ApplicationError } from './application/errors.js';
import { formatDirectGitStatusAnswer, isDirectGitStatusQuestion } from './application/gemma/direct-chat-contract.js';
import { ProviderRunRecorder } from './application/usage/provider-run-recorder.js';
import { GemmaMicroEditService } from './application/gemma/micro-edit-service.js';
import { buildRunMonitor } from './application/tasks/run-monitor-service.js';
import { TaskControlService } from './application/tasks/task-control-service.js';
export { evaluateRunHealth } from './application/tasks/run-monitor-service.js';

export class TaskManager {
  private readonly events: TaskEventPublisher;
  private readonly scheduler: ProjectTaskScheduler;
  private readonly ownership: ProjectTaskOwnershipService;
  private readonly taskControls: TaskControlService;
  private readonly gitFinalization: GitFinalizationService;
  private readonly gemmaMicroEdits = new GemmaMicroEditService();
  private readonly contextWarnings = new Set<string>();
  private readonly manualCommits = new Set<string>();
  private readonly controlRequests = new Map<string, 'pause' | 'stop'>();
  private antigravityModels: string[] = [];

  constructor(private readonly store: Store, maxGlobal = 2) {
    const providerRuns = new ProviderRunRecorder(store);
    this.events = new TaskEventPublisher(store, (event) => providerRuns.observe(event));
    this.scheduler = new ProjectTaskScheduler(store, (taskId, signal) => this.execute(taskId, signal), maxGlobal);
    this.taskControls = new TaskControlService(store, this.scheduler, this.controlRequests,
      (taskId, agent, type, payload) => this.emit(taskId, agent, type, payload));
    this.ownership = new ProjectTaskOwnershipService(store, this.scheduler,
      (taskId, type, payload) => this.emit(taskId, 'system', type, payload));
    this.gitFinalization = new GitFinalizationService(store);
    void this.refreshModels();
  }

  async refreshModels() { this.antigravityModels = await listAntigravityModels(); }

  enqueue(taskId: string) {
    this.scheduler.enqueue(taskId);
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void) {
    return this.events.subscribe(taskId, listener);
  }

  pause(taskId: string) { return this.taskControls.pause(taskId); }

  resume(taskId: string) { return this.taskControls.resume(taskId); }

  cancel(taskId: string) { return this.taskControls.stop(taskId); }
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
    this.emit(taskId, 'system', 'task.resumed', { message: 'The reviewed Jules PR head is local. Starting Antigravity repair; it will continue until review passes or you stop the task.', source: 'jules_local_takeover' });
    this.emit(taskId, 'system', 'task.state', { state: 'recovering' });
    this.enqueue(taskId);
    return requireTask(this.store, taskId);
  }

  async recover(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    return this.resumePreservedTask(task);
  }

  private async resumePreservedTask(task: TaskRecord): Promise<TaskRecord> {
    const disposition = recoveryDisposition(task.state, this.scheduler.isRunning(task.id));
    if (disposition === 'already_active') return task;
    if (disposition === 'reject') throw new ApplicationError('TASK_NOT_RECOVERABLE', 'Only a failed or recovery-required task with preserved changes can be resumed.', 409,
      { nextAction: 'Refresh the task and use Retry only when the project worktree is clean.', retryable: false });
    const project = requireProject(this.store, task.projectId);
    const classification = parseTaskClassification(task.classification);
    const status = await getGitStatus(project.root);
    const recoverableFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (!classification?.mutating || !status.isGit || !recoverableFiles.length) throw new ApplicationError('TASK_HAS_NO_RECOVERABLE_CHANGES', 'This task has no recoverable uncommitted implementation changes.', 409,
      { nextAction: 'Use Retry to start again from the current clean project state.', retryable: true });
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
    if (task.state !== 'failed') throw new ApplicationError('TASK_NOT_RETRYABLE', 'Only a failed task can be retried from a clean project state.', 409,
      { nextAction: 'Refresh the task and use Resume when preserved changes are present.', retryable: false });
    if (this.activeTaskId(task.projectId)) throw new ApplicationError('PROJECT_TASK_ACTIVE', 'Another task already owns this project.', 409,
      { nextAction: 'Open the active task instead of creating a duplicate queue entry.', retryable: false });
    const project = requireProject(this.store, task.projectId);
    const classification = parseTaskClassification(task.classification);
    const status = await getGitStatus(project.root);
    const projectFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (classification?.mutating && projectFiles.length) throw new ApplicationError('TASK_RETRY_HAS_PRESERVED_CHANGES', 'This failed task has uncommitted changes.', 409,
      { nextAction: 'Use Resume so Orchestra preserves task ownership through review and finalization.', retryable: false });
    this.store.updateTask(taskId, { state: 'queued', error: null });
    this.emit(taskId, 'system', 'task.retry', { message: 'Retrying the failed task from the current clean project state.' });
    this.emit(taskId, 'system', 'task.state', { state: 'queued' });
    this.enqueue(taskId);
  }

  async commitUncommittedChanges(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.state === 'completed' || task.state === 'completed_unpushed') return task;
    const allowedStates: TaskState[] = ['baseline_required', 'paused', 'recovery_required', 'review_disputed', 'failed'];
    if (!allowedStates.includes(task.state)) throw new ApplicationError('TASK_STILL_RUNNING', `This task is ${task.state.replaceAll('_', ' ')}. Stop or pause it before committing its working changes.`, 409,
      { nextAction: 'Stop or pause the task, then use Commit & Push Changes.', retryable: true });
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
        (agent, type, payload) => this.emit(taskId, agent, type, payload),
        { simple: true },
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
            : 'Refresh the task; no empty commit was created.', retryable: false },
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

  activeTaskId(projectId: string) {
    return this.ownership.current(projectId)?.id ?? null;
  }

  activeTask(projectId: string): TaskRecord | null {
    return this.ownership.current(projectId);
  }

  reconcileProjectOwner(projectId: string): Promise<TaskRecord | null> {
    return this.ownership.reconcile(projectId);
  }

  async getMonitor(taskId: string): Promise<RunMonitor> {
    return buildRunMonitor(this.store, this.scheduler, taskId);
  }

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
        classified = { classification: originalClassification, source: 'recovery' as const, warning: undefined };
      } else {
        classified = await classifyTask(task.prompt);
      }
      const classification = classified.classification;
      if (classified.warning) this.emit(taskId, 'gemma', 'warning', { message: `Gemma classification unavailable; deterministic routing was used. ${classified.warning}` });
      else if (classification.executionMode !== 'direct') this.emit(taskId, 'gemma', 'agent.completed', { phase: 'classification', classification, recovered: recovery });

      if (classification.executionMode === 'direct' && (classification.directAgent || 'gemma') === 'gemma' && isDirectGitStatusQuestion(task.prompt)) {
        const selectedModel = (classification as any).directModel || config.lmStudioModel;
        const directModels: ModelSelection = {
          primary: 'gemma',
          gemma: selectedModel,
          antigravity: 'gemini-3.7-flash-high',
          antigravityEffort: 'high',
          codex: null,
          codexEffort: null,
        };
        this.store.updateTask(taskId, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(directModels) });
        this.transition(taskId, 'running');
        this.emit(taskId, 'system', 'agent.started', { phase: 'direct-git-status', message: 'Reading the selected project Git status directly.' });
        const status = await getGitStatus(project.root);
        const answer = formatDirectGitStatusAnswer(project.root, status);
        this.emit(taskId, 'system', 'agent.completed', { phase: 'direct-git-status', isGit: status.isGit, changedFiles: status.files.length });
        this.complete(taskId, answer, 'system');
        return;
      }

      const activeGemmaModel = await getActiveLmStudioModel();

      if (classification.executionMode === 'direct') {
        const directAgent = classification.directAgent || 'gemma';
        const directModel = (classification as any).directModel || null;
        const directEffort = (classification as any).directEffort || 'high';

        const chosenAntigravity = directAgent === 'antigravity' ? (directModel || 'gemini-3.7-flash-high') : 'gemini-3.7-flash-high';
        const chosenCodex = directAgent === 'codex' ? (directModel || 'gpt-5.6-sol') : null;
        const chosenGemma = directAgent === 'gemma' ? (directModel || activeGemmaModel) : activeGemmaModel;

        const directModels: ModelSelection = {
          primary: directAgent,
          gemma: chosenGemma,
          antigravity: chosenAntigravity,
          antigravityEffort: directAgent === 'antigravity' ? directEffort : 'high',
          codex: chosenCodex,
          codexEffort: directAgent === 'codex' ? directEffort : null,
        };
        this.store.updateTask(taskId, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(directModels) });
        this.transition(taskId, 'running');

        let mcpStatus: McpStatus | null = null;
        try { mcpStatus = await getMcpStatus(); } catch { /* ignore */ }
        const riderFor = (agent: keyof McpStatus['agents']) => mcpStatus?.agents[agent].available === true;

        if (directAgent === 'gemma') {
          const model = chosenGemma;
          this.emit(taskId, 'gemma', 'agent.started', { phase: 'direct-chat', model });
          const asksAboutRepo = /\b(?:code|file|repo|git|commit|diff|build|test|bug|error|function|class|method|import|export|component|server|src|package|docs|orchestra|agent|architecture|review|why|how)\b/i.test(task.prompt);
          let evidence: RepositoryEvidence | undefined;
          if (asksAboutRepo) {
            const [status, commits, diff] = await Promise.all([
              getGitStatus(project.root),
              getRecentCommits(project.root, 5),
              getDiff(project.root, 4_000),
            ]);
            evidence = collectRepositoryEvidence(project.root, task.prompt, status, commits, diff, 8_000);
          }
          const answer = await runGemmaDirectChat({
            root: project.root,
            model,
            prompt: task.prompt,
            evidence,
            signal,
            onOutput: (chunk) => this.stream(taskId, 'gemma', chunk),
            onUsage: (usage) => this.recordLocalProviderTelemetry(taskId, usage),
          });
          this.emit(taskId, 'gemma', 'agent.completed', { phase: 'direct-chat', result: answer });
          this.complete(taskId, answer, 'gemma');
          return;
        }

        if (directAgent === 'codex') {
          const model = chosenCodex || 'gpt-5.6-sol';
          this.emit(taskId, 'codex', 'agent.started', { role: 'direct-chat', model, effort: directEffort });
          const answer = await runCodexAnalysis({
            root: project.root,
            prompt: task.prompt,
            role: 'Direct Architecture & Code Consultation',
            model,
            effort: directEffort,
            riderAvailable: riderFor('codex'),
            signal,
            onOutput: (chunk) => this.stream(taskId, 'codex', chunk),
            onUsage: (usage) => this.recordProviderTelemetry(taskId, 'codex', usage),
          });
          this.emit(taskId, 'codex', 'agent.completed', { role: 'direct-chat', summary: answer.slice(-3000) });
          this.complete(taskId, answer, 'codex');
          return;
        }

        if (directAgent === 'antigravity') {
          const model = chosenAntigravity;
          this.emit(taskId, 'antigravity', 'agent.started', { role: 'direct-chat', model });
          const result = await runAntigravity({
            root: project.root,
            prompt: `Answer the user inquiry directly in conversational read-only mode. Do not modify files:\n\n${task.prompt}`,
            model,
            effort: directEffort,
            mutating: false,
            conversationId: session.antigravityConversationId,
            riderAvailable: riderFor('antigravity'),
            signal,
            onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk),
            onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage),
          });
          this.emit(taskId, 'antigravity', 'agent.completed', { role: 'direct-chat', result: result.text });
          this.complete(taskId, result.text, 'antigravity');
          return;
        }
      }

      if (!recovery && classification.localOperation === 'connect_git_remote') {
        const localModels: ModelSelection = { ...selectModels(classification), primary: 'gemma', gemma: activeGemmaModel, codex: null, codexEffort: null };
        this.store.updateTask(taskId, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(localModels) });
        this.transition(taskId, 'preflight');
        if (project.onboardingStatus === 'scope_warning') throw new Error('The selected directory contains nested Git repositories. Select the specific repository you want to connect.');
        const remoteUrl = findRecentGitHubUrl(this.store, session.id, task.prompt);
        if (!remoteUrl) throw new Error('Gemma identified a Git remote connection request, but no valid HTTPS GitHub repository URL was found in the recent conversation.');
        this.transition(taskId, 'running');
        this.emit(taskId, 'gemma', 'agent.started', { phase: 'local-operation', operation: 'connect_git_remote', model: activeGemmaModel });
        const connected = await connectGitHubRemote(project.root, remoteUrl);
        this.store.updateTask(taskId, { commitSha: connected.head, pushStatus: 'pushed' });
        this.store.createGitOperation(project.id, taskId, 'connect_remote', connected.head, connected.branch, 'pushed', null);
        this.emit(taskId, 'git', 'git.remote', connected);
        this.emit(taskId, 'git', 'git.push', { pushed: true, remote: connected.remote, branch: connected.branch });
        this.emit(taskId, 'gemma', 'agent.completed', { phase: 'local-operation', operation: 'connect_git_remote' });
        this.complete(taskId, `Connected this project to ${connected.remote} as \`origin\` and pushed \`${connected.branch}\` at commit \`${connected.head}\`.`, 'gemma');
        return;
      }
      const antigravityAccount = await readAntigravityUsage();
      let models: ModelSelection = { ...selectModels(classification, recovery ? 1 : 0), primary: 'antigravity', gemma: activeGemmaModel };
      const resolved = resolveAntigravityModel(models.antigravity, this.antigravityModels);
      models = { ...models, antigravity: resolved.model };
      if (resolved.warning) this.emit(taskId, 'antigravity', 'warning', { message: resolved.warning });
      this.store.updateTask(taskId, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(models) });

      this.transition(taskId, 'preflight');
      if (project.onboardingStatus === 'scope_warning') throw new Error('The selected directory contains nested Git repositories. Select the specific repository you want the agents to work in.');
      let status = await getGitStatus(project.root);
      const projectChanges = status.files.filter((file) => !isOrchestraInternalPath(file.path));
      if (classification.mutating && status.isGit && projectChanges.length && !recovery) {
        this.transition(taskId, 'baseline_required');
        this.emit(taskId, 'git', 'git.baseline-required', {
          files: projectChanges,
          message: `${projectChanges.length} project file${projectChanges.length === 1 ? ' has' : 's have'} uncommitted changes. Use Commit & Push Changes to commit them.`,
        });
        return;
      }
      if (classification.mutating && status.isGit && projectChanges.length && recovery) {
        this.emit(taskId, 'system', 'task.recovery', { message: 'Continuing from changes owned by this failed task; they will not be committed as a separate baseline.' });
      }
      if (!['ready', 'ready_unpushed', 'ready_non_git'].includes(project.onboardingStatus)) {
        const onboarding = await onboardProject(this.store, project);
        this.emit(taskId, 'system', 'project.onboarding', onboarding);
        status = await getGitStatus(project.root);
      }
      if (classification.mutating && !status.isGit) {
        const initialized = await initializeGreenfieldRepository(this.store, project);
        this.emit(taskId, 'system', 'project.onboarding', initialized);
        status = await getGitStatus(project.root);
        if (!status.isGit) {
          throw new Error('File-changing tasks require a Git repository so Orchestra can review, verify, and preserve changes. This non-Git directory contains project files, so Orchestra will not initialize it automatically. Initialize Git in the selected directory, create a clean baseline commit, and retry.');
        }
      }
      if (classification.mutating && status.isGit) {
        const remoteUrl = findRecentGitHubUrl(this.store, session.id, task.prompt);
        if (remoteUrl && !status.upstream) {
          try {
            const connected = await connectGitHubRemote(project.root, remoteUrl);
            this.emit(taskId, 'git', 'git.remote', connected);
          } catch { /* already configured or non-blocking */ }
        }
      }

      let mcpStatus: McpStatus | null = null;
      try {
        mcpStatus = await getMcpStatus();
        if (mcpStatus.server.operational) {
          this.emit(taskId, 'system', 'mcp.capability', {
            message: `Rider MCP is available with ${mcpStatus.server.toolCount} tools. Orchestra will encourage semantic Rider inspection where it improves this task.`,
            agents: mcpStatus.agents,
          });
        } else this.emit(taskId, 'system', 'mcp.capability', { message: `Rider MCP is unavailable; agents will use their ordinary tools. ${mcpStatus.server.reason || ''}`.trim() });
      } catch (error) {
        this.emit(taskId, 'system', 'mcp.capability', { message: `Rider MCP capability detection failed; agents will use their ordinary tools. ${error instanceof Error ? error.message : String(error)}` });
      }
      const riderFor = (agent: keyof McpStatus['agents']) => mcpStatus?.agents[agent].available === true;
      const runAntigravityWithFailover = async (input: Parameters<typeof runAntigravity>[0], stage: string): Promise<AgentRunResult> => {
        let result: AgentRunResult;
        try {
          result = await runAntigravity(input);
          if (!result.incomplete) return result;
        } catch (error) {
          if (signal.aborted) throw error;
          if (!input.mutating) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          result = {
            text: `Antigravity did not complete the ${stage} turn: ${reason}`,
            conversationId: null,
            raw: '',
            warning: `Antigravity did not complete the ${stage} turn. Orchestra is transferring control to its local failure triage and independent Codex workflow.`,
            usage: null,
            terminalStatus: providerFailureStatus(reason),
            incomplete: true,
            failureReason: reason,
            continuationGuidance: null,
          };
        }

        let changedFiles: string[] = [];
        try { changedFiles = (await getGitStatus(project.root)).files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path)); } catch { /* Codex receives the Git failure if inspection remains unavailable. */ }
        if (hasReviewablePreservedProviderOutput(result, changedFiles.length)) {
          result.continuationGuidance = 'Review the complete preserved change set against the original request and repair only concrete findings.';
          this.emit(taskId, 'system', 'task.model-takeover', {
            message: `Antigravity returned a final response with terminal status ${result.terminalStatus || 'ERROR'}, but preserved ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}. Orchestra will skip speculative failure triage and send the complete change set directly to independent review.`,
            from: 'antigravity', to: 'codex-review', stage, category: 'preserved_non_success', changedFiles: changedFiles.length,
          });
          return result;
        }
        const fallback: ProviderFailureTriage = {
          category: result.terminalStatus === 'TIMEOUT' || result.terminalStatus === 'IDLE_TIMEOUT' ? 'timeout' : result.terminalStatus === 'PROCESS_ERROR' ? 'process_exit' : /subagent|paus|wait/i.test(result.text) ? 'delegated_wait' : 'unknown',
          summary: result.failureReason || result.warning || 'Antigravity ended before returning a usable completion.',
          continuationInstructions: 'Inspect the preserved working tree, finish missing work directly in a fresh foreground turn, and run synchronous verification without delegation or scheduled waits.',
          safeToReviewPreservedDiff: true,
        };
        let triage = fallback;
        this.emit(taskId, 'gemma', 'agent.started', { phase: 'provider-failure-triage', provider: 'antigravity', stage, changedFiles: changedFiles.length });
        try {
          triage = await triageProviderFailure({ stage, error: result.failureReason || result.warning || result.terminalStatus || 'Unknown provider failure', lastOutput: result.text, changedFiles });
          this.emit(taskId, 'gemma', 'agent.completed', { phase: 'provider-failure-triage', provider: 'antigravity', stage, ...triage });
        } catch (error) {
          this.emit(taskId, 'gemma', 'warning', { message: `Local provider-failure triage was unavailable; deterministic failover is continuing. ${error instanceof Error ? error.message : String(error)}` });
        }
        result.continuationGuidance = triage.continuationInstructions;
        const disposition = providerFailoverDisposition(changedFiles.length);
        this.emit(taskId, 'system', 'task.model-takeover', {
          message: disposition === 'review_preserved_diff'
            ? `Gemma identified an Antigravity ${triage.category.replaceAll('_', ' ')} during ${stage}. ${changedFiles.length} preserved file${changedFiles.length === 1 ? '' : 's'} will transfer to Codex for independent review.`
            : `Gemma identified an Antigravity ${triage.category.replaceAll('_', ' ')} during ${stage}. Codex will diagnose a fresh foreground continuation before Antigravity retries.`,
          from: 'antigravity', to: disposition === 'review_preserved_diff' ? 'codex-review' : 'gemma-codex-diagnosis', stage, category: triage.category, changedFiles: changedFiles.length,
        });
        return result;
      };

      const evidence = !classification.mutating ? collectRepositoryEvidence(project.root, task.prompt, status) : null;
      const sessionContext = await this.prepareSessionContext(taskId, session);
      if (evidence && shouldAttemptGemmaAnswer(classification, task.prompt)) {
        this.transition(taskId, 'running');
        this.emit(taskId, 'gemma', 'agent.started', { phase: 'repository-answer', model: config.lmStudioModel, evidenceFiles: evidence.includedFiles.length, estimatedTokens: evidence.estimatedTokens });
        try {
          const local = await answerRepositoryQuestion({
            root: project.root,
            prompt: task.prompt,
            evidence,
            sessionContext,
            onToolActivity: (activity) => this.emit(taskId, 'gemma', 'mcp.tool', { ...activity, message: `Gemma Rider MCP tool ${activity.tool} ${activity.status}${activity.detail ? `: ${activity.detail}` : '.'}` }),
            onUsage: (usage) => this.recordLocalProviderTelemetry(taskId, usage),
          });
          if (local.canAnswer) {
            models = { ...models, primary: 'gemma' };
            this.store.updateTask(taskId, { models: JSON.stringify(models) });
            this.emit(taskId, 'gemma', 'agent.completed', { phase: 'repository-answer', confidence: local.confidence, evidenceFiles: local.evidenceFiles, limitations: local.limitations, attempts: local.attempts });
            this.complete(taskId, local.answer, 'gemma');
            return;
          }
          this.emit(taskId, 'gemma', 'warning', {
            message: `Local answer was not accepted (${local.rejectionReasons.join('; ')}); escalating to the configured agent workflow.`,
            confidence: local.confidence,
            rejectionReasons: local.rejectionReasons,
            attempts: local.attempts,
          });
        } catch (error) {
          this.emit(taskId, 'gemma', 'warning', { message: `Local repository answering was unavailable; escalating safely. ${error instanceof Error ? error.message : String(error)}` });
        }
      }

      let agentResult: AgentRunResult | null = null;
      if (!recovery && status.head && isGemmaMicroEditCandidate(classification, task.prompt)) {
        this.transition(taskId, 'running');
        this.emit(taskId, 'gemma', 'agent.started', { phase: 'micro-edit', model: activeGemmaModel });
        const candidate = await this.gemmaMicroEdits.attempt({ taskId, projectRoot: project.root, baseSha: status.head, prompt: task.prompt, signal, onOutput: (chunk) => this.stream(taskId, 'gemma', chunk), onUsage: (usage) => this.recordLocalProviderTelemetry(taskId, usage) });
        if (candidate.applied) {
          models = { ...models, primary: 'gemma', gemma: activeGemmaModel };
          this.store.updateTask(taskId, { models: JSON.stringify(models) });
          this.emit(taskId, 'gemma', 'agent.completed', { phase: 'micro-edit', changedFiles: candidate.changedFiles, changedLines: candidate.changedLines, summary: candidate.summary });
          agentResult = { text: candidate.summary, conversationId: null, raw: candidate.summary, warning: null, usage: null, terminalStatus: 'SUCCESS', incomplete: false, failureReason: null, continuationGuidance: null };
        } else {
          this.emit(taskId, 'gemma', 'agent.failed', { phase: 'micro-edit', error: candidate.reason });
          this.emit(taskId, 'system', 'routing.adjustment', { message: `The bounded Gemma candidate was rejected without changing the main worktree. Falling back to Antigravity. ${candidate.reason}`, from: 'gemma', to: 'antigravity' });
        }
      }

      let specialistContext = '';
      if (!agentResult && !recovery && classification.codexRole !== 'none' && models.codex && models.codexEffort) {
        this.transition(taskId, 'reviewing');
        this.emit(taskId, 'codex', 'agent.started', { role: classification.codexRole, model: models.codex, effort: models.codexEffort });
        specialistContext = await runCodexAnalysis({ root: project.root, prompt: task.prompt, role: classification.codexRole, model: models.codex, effort: models.codexEffort, riderAvailable: riderFor('codex'), signal, onOutput: (chunk) => this.stream(taskId, 'codex', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'codex', usage) });
        this.emit(taskId, 'codex', 'agent.completed', { role: classification.codexRole, summary: specialistContext.slice(-4000) });
      }

      if (!agentResult) {
        this.transition(taskId, 'running');
        this.emit(taskId, 'antigravity', 'agent.started', { phase: 'implementation', model: models.antigravity, effort: models.antigravityEffort });
        const implementationContext = [specialistContext, recoveryReason ? `The previous automatic run paused for this reason:\n${recoveryReason}` : ''].filter(Boolean).join('\n\n');
        const contextUsed = antigravityAccount.workspace && samePath(antigravityAccount.workspace, project.root) ? antigravityAccount.context?.usedPercent : null;
        const priorInputTokens = latestAntigravityInputTokens(this.store, project.id, session.id, taskId);
        const rotateConversation = contextUsed !== null && contextUsed !== undefined && contextUsed >= 80 || priorInputTokens !== null && priorInputTokens >= 200_000;
        const conversationId = rotateConversation ? null : session.antigravityConversationId;
        if (!conversationId && session.antigravityConversationId && rotateConversation) this.emit(taskId, 'system', 'routing.adjustment', { message: contextUsed !== null && contextUsed !== undefined && contextUsed >= 80 ? `Antigravity context is ${contextUsed.toFixed(1)}% used. Orchestra started a fresh provider conversation while preserving the local session summary.` : `The previous Antigravity turn used ${priorInputTokens?.toLocaleString()} input tokens. Orchestra started a fresh provider conversation while preserving the local session summary.` });
        agentResult = await runAntigravityWithFailover({ root: project.root, prompt: task.prompt, model: models.antigravity, effort: models.antigravityEffort, mutating: classification.mutating, conversationId, context: implementationContext, recovery, riderAvailable: riderFor('antigravity'), signal, onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage) }, 'implementation');
      }
      let hadIncompleteAgentRun = agentResult.incomplete;
      if (agentResult.conversationId) this.store.setConversationId(session.id, agentResult.conversationId);
      if (agentResult.warning) this.emit(taskId, 'antigravity', 'warning', { message: agentResult.warning });
      if (agentResult.incomplete) this.emit(taskId, 'system', 'task.provider-recovery', { message: `Antigravity ended with status ${agentResult.terminalStatus || 'ERROR'} during implementation. Orchestra is inspecting the working tree and will either retry automatically or continue preserved changes into Codex review.`, provider: 'antigravity', status: agentResult.terminalStatus });
      else this.emit(taskId, 'antigravity', 'agent.completed', { summary: agentResult.text.slice(-5000) });

      if (classification.mutating) {
        let progress = implementationChangeState(status.head, await getGitStatus(project.root));
        if (progress === 'committed') throw new Error('Antigravity committed project changes directly. Orchestra stopped because it can no longer review and finalize the complete uncommitted change set safely.');
        for (let retryAttempt = 1; progress === 'none' && !signal.aborted; retryAttempt += 1) {
          let codexGuidance = '';
          this.transition(taskId, 'reviewing');
          this.emit(taskId, 'system', 'task.model-takeover', { message: `The implementation turn produced no reviewable diff. Codex is taking over failure diagnosis before fresh Antigravity attempt ${retryAttempt + 1}.`, from: 'antigravity', to: 'codex-diagnosis', attempt: retryAttempt });
          this.emit(taskId, 'codex', 'agent.started', { role: 'failover-diagnosis', model: 'gpt-5.6-terra', effort: 'high', attempt: retryAttempt });
          try {
            codexGuidance = await runCodexAnalysis({
              root: project.root,
              prompt: `Diagnose why an Antigravity implementation turn produced no reviewable project diff and provide concrete instructions for a fresh foreground retry. Do not edit files.\n\nOriginal request:\n${task.prompt}\n\nProvider failure or output:\n${agentResult.failureReason || agentResult.text}\n\nGemma continuation guidance:\n${agentResult.continuationGuidance || 'No local guidance was available.'}`,
              role: 'debug', model: 'gpt-5.6-terra', effort: 'high', riderAvailable: riderFor('codex'), signal,
              onOutput: (chunk) => this.stream(taskId, 'codex', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'codex', usage),
            });
            this.emit(taskId, 'codex', 'agent.completed', { role: 'failover-diagnosis', attempt: retryAttempt, summary: codexGuidance.slice(-4000) });
          } catch (error) {
            this.emit(taskId, 'codex', 'warning', { message: `Codex failover diagnosis was unavailable; Gemma's guidance and deterministic retry policy will continue. ${error instanceof Error ? error.message : String(error)}` });
          }
          this.transition(taskId, 'running');
          this.emit(taskId, 'system', 'task.implementation-retry', { attempt: retryAttempt, message: `Orchestra is starting fresh foreground implementation attempt ${retryAttempt + 1} with Gemma/Codex recovery guidance. It will continue until work is produced or you stop the task.` });
          agentResult = await runAntigravityWithFailover({
            root: project.root,
            prompt: `The prior implementation turn produced no project file changes. Implement the original request now using the recovery guidance below. Work directly in this foreground turn: do not invoke or wait for subagents, delegate the task, use scheduled waits, return another plan, request approval, or stop at analysis. Create or modify the necessary project files, run synchronous verification, and leave the complete changes uncommitted for Orchestra review.\n\nOriginal request:\n${task.prompt}\n\nGemma failure guidance:\n${agentResult.continuationGuidance || 'Inspect the project and finish the request directly.'}\n\nCodex failure diagnosis:\n${codexGuidance || 'No Codex diagnosis was available; follow the deterministic foreground requirements.'}`,
            model: models.antigravity,
            effort: 'high',
            mutating: true,
            conversationId: null,
            riderAvailable: riderFor('antigravity'),
            signal,
            onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk),
            onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage),
          }, `implementation retry ${retryAttempt}`);
          hadIncompleteAgentRun ||= agentResult.incomplete;
          if (agentResult.conversationId) this.store.setConversationId(session.id, agentResult.conversationId);
          if (agentResult.warning) this.emit(taskId, 'antigravity', 'warning', { message: agentResult.warning });
          if (agentResult.incomplete) this.emit(taskId, 'system', 'task.provider-recovery', { message: `Antigravity's foreground retry ended with status ${agentResult.terminalStatus || 'ERROR'}. Orchestra will continue with any preserved diff or another attempt until you stop the task.`, provider: 'antigravity', status: agentResult.terminalStatus, attempt: retryAttempt });
          else this.emit(taskId, 'antigravity', 'agent.completed', { retry: retryAttempt, summary: agentResult.text.slice(-5000) });
          progress = implementationChangeState(status.head, await getGitStatus(project.root));
          if (progress === 'committed') throw new Error('Antigravity committed project changes directly during the automatic retry. Orchestra stopped because it cannot safely review and finalize that hidden change set.');
        }
        if (signal.aborted) return;
      }

      if (!classification.mutating && evidence) agentResult.text = await this.postflight(taskId, project.root, task.prompt, agentResult.text, evidence);

      if (classification.mutating) {
        const afterAgent = await getGitStatus(project.root);
        if (!afterAgent.isGit) throw new Error('The project stopped being a Git repository during implementation. Orchestra will not accept or finalize unreviewable changes.');
        const agentChanges = afterAgent.files.filter((file) => !isOrchestraInternalPath(file.path));
        if (agentChanges.length) {
          const takeover = this.store.manager.checkpoints.latest(taskId, 'local_takeover');
          const takeoverBaseSha = takeover && typeof takeover.data.baseSha === 'string' && /^[0-9a-f]{40}$/i.test(takeover.data.baseSha)
            ? takeover.data.baseSha
            : null;
          const reviewBaseSha = takeoverBaseSha || status.head;
          let previousFindings = '';
          let previousReview = '';
          let previousRepairChanged = true;
          let lastReviewedDiff = '';
          let lastReview = '';
          let verificationPassed = false;
          for (let cycle = 0; !verificationPassed; cycle += 1) {
            if (signal.aborted) return;
            const reviewStatus = await getGitStatus(project.root);
            const changedFiles = (reviewBaseSha
              ? await getChangedFilesFromBase(project.root, reviewBaseSha)
              : reviewStatus.files.map((file) => file.path))
              .filter((path) => !isOrchestraInternalPath(path));
            const diff = reviewBaseSha ? await getDiffFromBase(project.root, reviewBaseSha, 80_000) : await getDiff(project.root, 80_000);
            const currentDiffFingerprint = diffFingerprint(diff);
            if (!changedFiles.length || !diff.trim()) {
              throw new Error('Orchestra could not construct a reviewable base-to-head change set after implementation. The task was stopped before spending review quota on an empty evidence packet.');
            }
            this.transition(taskId, 'verifying');
            let verificationFailure = '';
            let verification: Array<{ command: string; code: number; output: string }> = [];
            try {
              verification = await verifyProject(project.root, signal);
              this.emit(taskId, 'verification', 'verification.result', { results: verification });
              verificationFailure = describeVerificationFailure(verification);
            } catch (error) {
              verificationFailure = error instanceof Error ? error.message : String(error);
              this.emit(taskId, 'verification', 'warning', { message: `Verification infrastructure failed; Orchestra is routing the failure through automatic repair before spending Codex review usage. ${verificationFailure}` });
            }

            let review = '';
            let blocked = true;
            if (verificationFailure) {
              const failedItem = verification.find((item) => item.code !== 0);
              const failedCmd = failedItem?.command || 'verification';
              this.emit(taskId, 'gemma', 'agent.started', { phase: 'verification-distillation', command: failedCmd });
              const distilled = await distillVerificationErrors(verificationFailure, failedCmd);
              this.emit(taskId, 'gemma', 'agent.completed', { phase: 'verification-distillation', summary: distilled.summary, findingCount: distilled.findings.length });
              review = `VERDICT: BLOCK\n\nOrchestra deterministic verification failed before independent review.\n\n${distilled.repairPromptChunk}`;
              this.emit(taskId, 'system', 'task.model-takeover', { message: `Deterministic verification failed before Codex review. Gemma distilled ${distilled.findings.length} actionable failure finding(s) for Antigravity repair.`, from: 'verification', to: 'antigravity-repair', cycle: cycle + 1 });
            } else if (currentDiffFingerprint === lastReviewedDiff && lastReview) {
              review = lastReview;
              blocked = extractCodexReviewVerdict(review).blocked;
              this.emit(taskId, 'system', 'routing.adjustment', { message: 'The verified diff is unchanged since the previous independent review. Orchestra reused that review instead of spending another Codex turn.', reviewReused: true, diffFingerprint: currentDiffFingerprint });
            } else {
              let triage: ReviewTriage = { risk: 'normal', summary: 'Local triage was unavailable; review the bounded diff directly.', focusFiles: [], concerns: [] };
              this.emit(taskId, 'gemma', 'agent.started', { phase: 'review-triage', cycle: cycle + 1, changedFiles: changedFiles.length });
              try {
                triage = await triageReview({ request: task.prompt, diff, changedFiles });
                this.emit(taskId, 'gemma', 'agent.completed', { phase: 'review-triage', cycle: cycle + 1, risk: triage.risk, focusFiles: triage.focusFiles, concerns: triage.concerns });
              } catch (error) {
                this.emit(taskId, 'gemma', 'warning', { message: `Local review triage was unavailable; Codex will receive the deterministic diff packet. ${error instanceof Error ? error.message : String(error)}` });
              }
              try {
                const sanity = await preReviewSanityCheck({ root: project.root, changedFiles, diff });
                if (!sanity.passed && sanity.issues.length) this.emit(taskId, 'gemma', 'warning', { message: `Local sanity check noted issues: ${sanity.issues.join('; ')}` });
              } catch { /* non-blocking */ }
              const profile = selectReviewProfile({ request: task.prompt, cycle, changedFileCount: changedFiles.length, triageRisk: triage.risk, repeatedFindings: cycle > 0 && !previousRepairChanged });
              this.emit(taskId, 'system', 'routing.adjustment', { message: `Verified review cycle ${cycle + 1} uses ${profile.model} (${profile.reason}).`, reviewModel: profile.model, reviewEffort: profile.effort, reason: profile.reason });
              const reviewPacket = buildReviewPacket({ request: task.prompt, changedFiles, diff, implementationSummary: agentResult.text, triage, previousReview });
              this.transition(taskId, 'reviewing');
              this.emit(taskId, 'codex', 'agent.started', { role: 'review', model: profile.model, effort: profile.effort, cycle: cycle + 1, changedFiles: changedFiles.length, triageRisk: triage.risk, packetCharacters: reviewPacket.length, packetFingerprint: diffFingerprint(reviewPacket), estimatedInputTokens: Math.ceil(reviewPacket.length / 2) });
              review = await runCodexReview({ root: project.root, model: profile.model, effort: profile.effort, reviewPacket, riderAvailable: riderFor('codex'), signal, onOutput: (chunk) => this.stream(taskId, 'codex', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'codex', usage) });
              lastReviewedDiff = currentDiffFingerprint;
              lastReview = review;
              const reviewResult = extractCodexReviewVerdict(review);
              blocked = reviewResult.blocked;
              this.emit(taskId, 'codex', 'agent.completed', { role: 'review', blocked, verdict: reviewResult.verdict, model: profile.model, cycle: cycle + 1, summary: review.slice(-5000) });
              if (!blocked) {
                verificationPassed = true;
                break;
              }
            }
            const findings = reviewFingerprint(review);
            const repeatedWithoutProgress = Boolean(previousFindings && findings === previousFindings && !previousRepairChanged);
            if (repeatedWithoutProgress) {
              this.emit(taskId, 'system', 'task.model-takeover', { message: 'Codex confirmed the same blockers after a no-progress repair. Orchestra is starting another fresh Antigravity repair conversation and will keep trying until review passes or you stop the task.', from: 'codex-review', to: 'antigravity-fresh-repair', cycle: cycle + 1 });
            }
            const beforeRepair = diffFingerprint(reviewBaseSha ? await getDiffFromBase(project.root, reviewBaseSha) : await getDiff(project.root));
            this.transition(taskId, 'running');
            const priorIncomplete = agentResult.incomplete;
            agentResult = await runAntigravityWithFailover({ root: project.root, prompt: `Address every blocking finding in this Codex review, then rerun relevant verification. ${repeatedWithoutProgress ? 'The previous repair made no progress, so use a different implementation approach in this fresh turn. ' : ''}Perform the repair directly in this foreground turn; do not invoke or wait for subagents, delegate the repair, use scheduled waits, or pause before synchronous verification completes:\n\n${review}`, model: models.antigravity, effort: 'high', mutating: true, conversationId: priorIncomplete || repeatedWithoutProgress ? null : agentResult.conversationId || session.antigravityConversationId, riderAvailable: riderFor('antigravity'), signal, onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage) }, `repair cycle ${cycle + 1}`);
            hadIncompleteAgentRun ||= agentResult.incomplete;
            if (agentResult.warning) this.emit(taskId, 'antigravity', 'warning', { message: agentResult.warning });
            if (agentResult.incomplete) this.emit(taskId, 'system', 'task.provider-recovery', { message: `Antigravity's repair turn ended with status ${agentResult.terminalStatus || 'ERROR'}. Orchestra preserved the repair diff and is returning it to Codex review automatically.`, provider: 'antigravity', status: agentResult.terminalStatus, attempt: cycle + 1 });
            const afterRepair = diffFingerprint(reviewBaseSha ? await getDiffFromBase(project.root, reviewBaseSha) : await getDiff(project.root));
            previousRepairChanged = beforeRepair !== afterRepair;
            previousFindings = findings;
            previousReview = review;
            this.emit(taskId, 'system', 'task.repair-progress', { attempt: cycle + 1, changed: previousRepairChanged, message: `Automatic repair ${cycle + 1} finished; returning the changes to review.` });
          }

          await this.finalizeGit(taskId, project, task.prompt, classification, models);
          if (hadIncompleteAgentRun) {
            const finalized = requireTask(this.store, taskId);
            const gitResult = finalized.commitSha ? ` Commit ${finalized.commitSha.slice(0, 8)} was ${finalized.pushStatus === 'pushed' ? 'created and pushed' : 'created; push remains pending'}.` : '';
            agentResult.text = `Orchestra completed the requested implementation after an Antigravity turn ended prematurely. Preserved changes passed independent Codex review and deterministic project verification.${gitResult}`;
          }
        }
      }

      this.complete(taskId, agentResult.text, 'antigravity');
    } catch (error) {
      if (signal.aborted || this.controlRequests.has(taskId)) return;
      await this.failOrRequireRecovery(taskId, project, error instanceof Error ? error.message : String(error));
    }
  }

  private async prepareSessionContext(taskId: string, session: Session) {
    const messages = this.store.listMessages(session.id);
    const unsummarized = session.summaryUpdatedAt ? messages.filter((message) => message.createdAt > session.summaryUpdatedAt!) : messages;
    const newCharacters = unsummarized.reduce((total, message) => total + message.content.length, 0);
    let summary = session.summary;
    if (newCharacters >= 8_000 || (!summary && messages.length >= 8)) {
      this.emit(taskId, 'gemma', 'agent.started', { phase: 'session-memory', messages: unsummarized.length });
      try {
        summary = await summarizeConversation(summary, unsummarized);
        this.store.setSessionSummary(session.id, summary);
        this.emit(taskId, 'gemma', 'agent.completed', { phase: 'session-memory', characters: summary.length });
      } catch (error) {
        this.emit(taskId, 'gemma', 'warning', { message: `Session memory refresh was skipped. ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const recent = messages.slice(-6).map((message) => `${message.role}: ${message.content}`).join('\n\n');
    return `${summary ? `Persistent memory:\n${summary}\n\n` : ''}Recent messages:\n${recent}`.slice(-30_000);
  }

  private async postflight(taskId: string, root: string, prompt: string, response: string, evidence: RepositoryEvidence) {
    const activeModel = await getActiveLmStudioModel().catch(() => null);
    this.emit(taskId, 'gemma', 'agent.started', { phase: 'postflight-validation', model: activeModel || config.lmStudioModel });
    let validation;
    try {
      validation = await validateAgentResponse({ root, prompt, response, evidence });
    } catch (error) {
      this.emit(taskId, 'gemma', 'warning', { message: `Local postflight validation was unavailable. ${error instanceof Error ? error.message : String(error)}` });
      return response;
    }
    this.emit(taskId, 'gemma', 'agent.completed', { phase: 'postflight-validation', ...validation });
    if (validation.status === 'block' && validation.confidence >= 0.9) {
      throw new Error(`Gemma blocked the remote response because it conflicts with repository evidence: ${validation.issues.join(' ')}`);
    }
    if (validation.status !== 'pass' && validation.issues.length) {
      return `${response}\n\n---\n\n### Local validation notes\n${validation.issues.map((issue) => `- ${issue}`).join('\n')}`;
    }
    return response;
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

  private async finalizeGit(taskId: string, project: Project, request: string, _classification: TaskClassification, _models: ModelSelection) {
    return this.gitFinalization.finalize(
      taskId, project, request,
      (state) => this.transition(taskId, state),
      (agent, type, payload) => this.emit(taskId, agent, type, payload),
    );
  }

  private transition(taskId: string, state: TaskState) {
    this.store.updateTask(taskId, { state });
    this.emit(taskId, 'system', 'task.state', { state });
  }

  private fail(taskId: string, message: string) {
    this.store.updateTask(taskId, { state: 'failed', error: message });
    for (const attempt of this.store.manager.attempts.listByTaskId(taskId)) {
      if (attempt.target === 'local' && attempt.state === 'WORKING') {
        this.store.manager.attempts.update(attempt.id, { state: 'FAILED', error: message.slice(0, 4_000), completedAt: new Date().toISOString() });
      }
    }
    this.emit(taskId, 'system', 'task.error', { message });
    this.emit(taskId, 'system', 'task.state', { state: 'failed' });
  }

  private async failOrRequireRecovery(taskId: string, project: Project, message: string) {
    const task = requireTask(this.store, taskId);
    const classification = parseTaskClassification(task.classification);
    let status = null;
    try { status = await getGitStatus(project.root); } catch { /* Preserve the original task error. */ }
    const recoverableFiles = status?.files.filter((file) => !isOrchestraInternalPath(file.path)) || [];
    if (classification?.mutating && status?.isGit && recoverableFiles.length) {
      const recoveryMessage = `${message} Uncommitted changes from this task were preserved and must be resumed or handled explicitly; Orchestra will not treat them as a pre-existing baseline.`;
      this.store.updateTask(taskId, { state: 'recovery_required', error: recoveryMessage });
      this.emit(taskId, 'system', 'task.error', { message: recoveryMessage });
      this.emit(taskId, 'system', 'task.recovery-required', { message: 'Partial task changes are preserved in the working tree.', files: recoverableFiles });
      this.emit(taskId, 'system', 'task.state', { state: 'recovery_required' });
      return;
    }
    this.fail(taskId, message);
  }

  private stream(taskId: string, agent: AgentName, chunk: string) {
    const cleaned = chunk.trim();
    if (cleaned) this.emit(taskId, agent, 'agent.output', { text: cleaned.slice(-4000) });
  }

  private recordProviderTelemetry(taskId: string, agent: 'antigravity' | 'codex', value: unknown) {
    this.emit(taskId, agent, 'provider.telemetry', value);
    if (agent !== 'codex' || !value || typeof value !== 'object') return;
    const telemetry = value as Record<string, any>;
    const usedPercent = Number(telemetry.context?.usedPercent);
    if (!Number.isFinite(usedPercent) || usedPercent < 80) return;
    const key = `${taskId}:${String(telemetry.threadId || 'codex')}`;
    if (this.contextWarnings.has(key)) return;
    this.contextWarnings.add(key);
    this.emit(taskId, 'system', 'routing.adjustment', {
      message: `Codex context reached ${usedPercent.toFixed(1)}% during this stage. Orchestra will let the active read-only turn finish, and the next Codex role or review cycle will use a fresh ephemeral thread.`,
      provider: 'codex',
      usedPercent,
    });
  }

  private recordLocalProviderTelemetry(taskId: string, usage: Record<string, number>) {
    this.emit(taskId, 'gemma', 'provider.telemetry', { usage });
  }

  private emit(taskId: string, agent: AgentName, type: TaskEventType, payload: unknown) {
    this.events.publish(taskId, agent, type, payload);
  }
}

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
  return result.incomplete && changedFileCount > 0 && Boolean(result.text.trim());
}

function diffFingerprint(diff: string) { return createHash('sha256').update(diff).digest('hex'); }
function samePath(left: string, right: string) { return left.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === right.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(); }
function latestAntigravityInputTokens(store: Store, projectId: string, sessionId: string, excludeTaskId: string) {
  for (const task of store.listTasks(projectId)) {
    if (task.id === excludeTaskId || task.sessionId !== sessionId) continue;
    const event = store.listEvents(task.id).findLast((item) => item.agent === 'antigravity' && item.type === 'provider.telemetry');
    const payload = event?.payload as Record<string, any> | undefined;
    const tokens = Number(payload?.usage?.input_tokens);
    if (Number.isFinite(tokens)) return tokens;
  }
  return null;
}
function findRecentGitHubUrl(store: Store, sessionId: string, prompt: string) {
  const direct = extractGitHubRemoteUrl(prompt);
  if (direct) return direct;
  const messages = store.listMessages(sessionId);
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - 30); index -= 1) {
    const found = extractGitHubRemoteUrl(messages[index].content);
    if (found) return found;
  }
  return null;
}
function requireTask(store: Store, id: string): TaskRecord {
  const task = store.getTask(id);
  if (!task) throw new Error('Task not found.');
  return task;
}

function requireProject(store: Store, id: string): Project {
  const project = store.getProject(id);
  if (!project) throw new Error('Project not found.');
  return project;
}

function parseTaskClassification(value: string | null): TaskClassification | null {
  if (!value) return null;
  try { return JSON.parse(value) as TaskClassification; } catch { return null; }
}
