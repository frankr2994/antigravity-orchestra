import { createHash } from 'node:crypto';
import { config } from './config.js';
import type { Store } from './db.js';
import type { AgentName, ModelSelection, Project, RunMonitor, Session, TaskClassification, TaskEvent, TaskRecord, TaskState } from './types.js';
import type { TaskEventType } from './domain/index.js';
import { ProjectTaskScheduler } from './application/tasks/project-task-scheduler.js';
import { TaskEventPublisher } from './application/tasks/task-event-publisher.js';
import { GitFinalizationService } from './application/git/git-finalization-service.js';
import { appendHandoff } from './application/git/handoff.js';
export { appendHandoff } from './application/git/handoff.js';
import { answerRepositoryQuestion, buildReviewPacket, classifyTask, distillVerificationErrors, extractCodexReviewVerdict, getActiveLmStudioModel, listAntigravityModels, preReviewSanityCheck, resolveAntigravityModel, runAntigravity, runCodexAnalysis, runCodexReview, runGemmaDirectChat, selectModels, selectReviewProfile, shouldAttemptGemmaAnswer, summarizeChanges, summarizeConversation, triageProviderFailure, triageReview, validateAgentResponse, type AgentRunResult, type ProviderFailureTriage, type QuotaPolicy, type ReviewTriage } from './agents.js';
import { collectRepositoryEvidence, type RepositoryEvidence } from './evidence.js';
import { commitPaths, connectGitHubRemote, extractGitHubRemoteUrl, getChangedFilesFromBase, getDiff, getDiffFromBase, getGitStatus, getRecentCommits, pushCurrent, safeCommitTitle } from './git.js';
import { initializeGreenfieldRepository, isOrchestraInternalPath, onboardProject } from './projects.js';
import { verificationFailure as describeVerificationFailure, verifyProject } from './verification.js';
import { readAntigravityTranscript, readAntigravityUsage, readCodexUsage } from './observability.js';
import { getMcpStatus, type McpStatus } from './mcp.js';
import { ApplicationError } from './application/errors.js';

export class TaskManager {
  private readonly events: TaskEventPublisher;
  private readonly scheduler: ProjectTaskScheduler;
  private readonly gitFinalization: GitFinalizationService;
  private readonly contextWarnings = new Set<string>();
  private readonly baselineResolutions = new Set<string>();
  private antigravityModels: string[] = [];

  constructor(private readonly store: Store, maxGlobal = 2) {
    this.events = new TaskEventPublisher(store);
    this.scheduler = new ProjectTaskScheduler(store, (taskId, signal) => this.execute(taskId, signal), maxGlobal);
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

  cancel(taskId: string) {
    const task = requireTask(this.store, taskId);
    if (['completed', 'completed_unpushed', 'failed', 'cancelled'].includes(task.state)) return;
    this.scheduler.remove(taskId);
    this.scheduler.abort(taskId);
    this.transition(taskId, 'cancelled');
    this.emit(taskId, 'system', 'task.state', { state: 'cancelled' });
  }

  async recover(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    const disposition = recoveryDisposition(task.state, this.activeTaskId(task.projectId) === task.id);
    if (disposition === 'already_active') return task;
    if (disposition === 'reject') throw new Error('Only a failed task with preserved changes can be recovered.');
    const project = requireProject(this.store, task.projectId);
    const classification = parseTaskClassification(task.classification);
    const status = await getGitStatus(project.root);
    const recoverableFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (!classification?.mutating || !status.isGit || !recoverableFiles.length) throw new Error('This task has no recoverable uncommitted implementation changes.');
    this.transition(taskId, 'recovering');
    this.emit(taskId, 'system', 'task.recovery', { message: 'Resuming the failed task with its preserved uncommitted changes.' });
    this.enqueue(taskId);
    return requireTask(this.store, taskId);
  }

  async retry(taskId: string) {
    const task = requireTask(this.store, taskId);
    if (task.state !== 'failed') throw new Error('Only a failed task can be retried from a clean project state.');
    if (this.activeTaskId(task.projectId)) throw new Error('Another task already owns this project. Open that task instead of creating a duplicate queue entry.');
    const project = requireProject(this.store, task.projectId);
    const classification = parseTaskClassification(task.classification);
    const status = await getGitStatus(project.root);
    const projectFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (classification?.mutating && projectFiles.length) throw new Error('This failed task has uncommitted changes. Use Resume so Orchestra preserves task ownership through review and finalization.');
    this.store.updateTask(taskId, { state: 'queued', error: null });
    this.emit(taskId, 'system', 'task.retry', { message: 'Retrying the failed task from the current clean project state.' });
    this.emit(taskId, 'system', 'task.state', { state: 'queued' });
    this.enqueue(taskId);
  }

  async resolveBaseline(taskId: string) {
    const task = requireTask(this.store, taskId);
    if (task.state !== 'baseline_required') throw new Error(`This task is ${task.state}, so its baseline cannot be resolved again.`);
    if (this.scheduler.isRunning(taskId)) throw new Error('This task is already running. Open its original conversation to follow progress.');
    if (this.baselineResolutions.has(taskId)) throw new ApplicationError('BASELINE_ALREADY_RUNNING', 'Gemma is already reviewing and committing this baseline.', 409);
    this.baselineResolutions.add(taskId);
    const project = requireProject(this.store, task.projectId);
    try {
      const status = await getGitStatus(project.root);
      if (!status.isGit) throw new ApplicationError('BASELINE_NOT_GIT', 'This project is not a Git repository.', 409);
      const baselineFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
      if (baselineFiles.length) {
        this.emit(task.id, 'gemma', 'agent.started', { phase: 'baseline-review', files: baselineFiles.length });
        let summary;
        try {
          const diff = await getDiff(project.root);
          summary = await summarizeChanges(diff, 'Review and preserve changes that existed before the dashboard task.');
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.emit(task.id, 'gemma', 'warning', { message: `Baseline review could not complete. The working tree was left unchanged. ${detail}` });
          throw new ApplicationError('BASELINE_REVIEW_UNAVAILABLE', 'Gemma could not finish reviewing the existing changes. Nothing was committed; check the task activity and retry.', 503, { cause: error });
        }
        appendHandoff(project.root, summary.summary, 'Baseline changes');
        const updated = await getGitStatus(project.root);
        const paths = updated.files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path));
        if (!paths.length) throw new ApplicationError('BASELINE_EMPTY', 'No project files remained after excluding Orchestra internal state from the baseline.', 409);
        const sha = await commitPaths(project.root, paths, safeCommitTitle(summary.title, 'chore: preserve existing changes'), summary.summary);
        const pushed = await pushCurrent(project.root);
        this.store.createGitOperation(project.id, task.id, 'baseline', sha, updated.branch, pushed.pushed ? 'pushed' : 'unpushed', pushed.error);
        this.emit(task.id, 'git', 'git.commit', { kind: 'baseline', sha, title: summary.title, files: paths });
        this.emit(task.id, 'git', 'git.push', pushed);
        this.emit(task.id, 'gemma', 'agent.completed', { phase: 'baseline-review', sha, summary: summary.summary });
      }
      const latestProject = requireProject(this.store, project.id);
      const onboarding = await onboardProject(this.store, { ...latestProject, onboardingStatus: 'pending' });
      this.emit(task.id, 'system', 'project.onboarding', onboarding);
      this.store.updateTask(task.id, { state: 'queued', error: null });
      this.emit(task.id, 'system', 'task.state', { state: 'queued' });
      this.enqueue(task.id);
    } finally {
      this.baselineResolutions.delete(taskId);
    }
  }

  async approveDisputed(taskId: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.state !== 'review_disputed') throw new Error(`Only a task in review_disputed state can be approved, but task is ${task.state}.`);
    const project = requireProject(this.store, task.projectId);
    const classification = parseTaskClassification(task.classification);
    const models = task.models ? JSON.parse(task.models) : selectModels(classification || { type: 'implementation', mutating: true, complexity: 'normal', riskFlags: [], codexRole: 'none', title: task.title });
    await this.finalizeGit(taskId, project, task.prompt, classification || { type: 'implementation', mutating: true, complexity: 'normal', riskFlags: [], codexRole: 'none', title: task.title }, models);
    this.complete(taskId, 'Task changes approved and committed by user after review dispute.', 'antigravity');
    return requireTask(this.store, taskId);
  }

  async steerDisputed(taskId: string, guidance: string): Promise<TaskRecord> {
    const task = requireTask(this.store, taskId);
    if (task.state !== 'review_disputed') throw new Error(`Only a task in review_disputed state can be steered, but task is ${task.state}.`);
    if (!guidance.trim()) throw new Error('Steering guidance cannot be empty.');
    this.store.addMessage({ sessionId: task.sessionId, taskId: task.id, role: 'user', agent: 'system', content: `Steering guidance:\n${guidance.trim()}` });
    this.store.updateTask(taskId, { state: 'recovering', error: null });
    this.emit(taskId, 'system', 'task.steer', { guidance: guidance.trim(), message: 'Resuming task with user-supplied steering guidance.' });
    this.enqueue(taskId);
    return requireTask(this.store, taskId);
  }

  activeTaskId(projectId: string) {
    return this.scheduler.activeTaskId(projectId);
  }

  async getMonitor(taskId: string): Promise<RunMonitor> {
    const task = requireTask(this.store, taskId);
    const project = requireProject(this.store, task.projectId);
    const events = this.store.listEvents(taskId);
    const now = Date.now();
    const lastEvent = events.at(-1);
    const stateEvent = events.findLast((event) => event.type === 'task.state' && String((event.payload as Record<string, unknown>).state) === task.state);
    const reviewEvent = events.findLast((event) => event.type === 'agent.started' && (event.payload as Record<string, unknown>).role === 'review');
    const repairEvent = events.findLast((event) => event.type === 'task.repair-progress');
    const processAlive = this.scheduler.isRunning(taskId);
    const lastActivityAt = lastEvent?.createdAt || task.updatedAt;
    const inactiveMs = Math.max(0, now - Date.parse(lastActivityAt));
    let changedFiles: string[] = [];
    try { changedFiles = (await getGitStatus(project.root)).files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path)); } catch { /* Monitoring must not alter task execution. */ }
    const health = evaluateRunHealth(task.state, processAlive, inactiveMs);
    const currentAgent = agentForState(task.state);
    const reviewCycle = Number((reviewEvent?.payload as Record<string, unknown> | undefined)?.cycle || 0);
    const repairAttempt = Number((repairEvent?.payload as Record<string, unknown> | undefined)?.attempt || 0);
    const session = this.store.getSession(task.sessionId);
    const [codexAccount, antigravityAccount] = await Promise.all([readCodexUsage(), readAntigravityUsage()]);
    const latestCodex = latestProviderTelemetry(events, 'codex');
    const latestAntigravity = latestProviderTelemetry(events, 'antigravity');
    const codexUsage = mergeProviderTelemetry(codexAccount, latestCodex);
    const antigravityUsage = mergeProviderTelemetry(antigravityAccount, latestAntigravity);
    const antigravityMatchesProject = !antigravityUsage.workspace || antigravityUsage.workspace.replaceAll('\\', '/').toLowerCase() === project.root.replaceAll('\\', '/').toLowerCase();
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
      reviewCycle,
      repairAttempt,
      changedFiles,
      summary: monitorSummary({ state: task.state, health, currentAgent, inactiveMs, reviewCycle, repairAttempt, changedFiles: changedFiles.length }),
      stopReason: ['recovery_required', 'failed', 'cancelled'].includes(task.state) ? task.error : null,
      providerTelemetry: { antigravity: antigravityMatchesProject ? antigravityUsage : { available: false, reason: 'The latest Antigravity snapshot belongs to another project.' }, codex: codexUsage },
      providerActivity: readAntigravityTranscript(session?.antigravityConversationId || antigravityUsage.conversationId || null),
    };
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
      const [codexAccount, antigravityAccount] = await Promise.all([readCodexUsage(), readAntigravityUsage()]);
      const routingReasons: string[] = [];
      const antigravityRemaining = minimumRemaining(antigravityAccount);
      const codexRemaining = minimumRemaining(codexAccount);
      const quotaPolicyJson = this.store.getSetting('quotaPolicy');
      let quotaPolicy: QuotaPolicy | undefined;
      try { quotaPolicy = quotaPolicyJson ? JSON.parse(quotaPolicyJson) as QuotaPolicy : undefined; } catch { /* ignore */ }

      let models: ModelSelection = { ...selectModels(classification, recovery ? 1 : 0, quotaPolicy, codexRemaining), primary: 'antigravity', gemma: activeGemmaModel };
      const resolved = resolveAntigravityModel(models.antigravity, this.antigravityModels);
      models = { ...models, antigravity: resolved.model };
      if (resolved.warning) this.emit(taskId, 'antigravity', 'warning', { message: resolved.warning });
      if (routingReasons.length) this.emit(taskId, 'system', 'routing.adjustment', { message: routingReasons.join(' '), antigravityRemaining, codexRemaining });
      this.store.updateTask(taskId, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(models) });

      this.transition(taskId, 'preflight');
      if (project.onboardingStatus === 'scope_warning') throw new Error('The selected directory contains nested Git repositories. Select the specific repository you want the agents to work in.');
      let status = await getGitStatus(project.root);
      const projectChanges = status.files.filter((file) => !isOrchestraInternalPath(file.path));
      if (classification.mutating && status.isGit && projectChanges.length && !recovery) {
        try {
          const diff = await getDiff(project.root, 35_000);
          const summary = await summarizeChanges(diff, 'Review and preserve existing working tree modifications before task execution.');
          appendHandoff(project.root, summary.summary, 'Auto-committed baseline');
          const updated = await getGitStatus(project.root);
          const paths = updated.files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path));
          if (paths.length) {
            const sha = await commitPaths(project.root, paths, safeCommitTitle(summary.title, 'chore(baseline): preserve existing working tree changes'), summary.summary);
            this.emit(taskId, 'git', 'git.commit', { kind: 'baseline', sha, title: summary.title, files: paths });
            this.emit(taskId, 'gemma', 'agent.completed', { phase: 'auto-baseline', sha, summary: summary.summary });
            status = await getGitStatus(project.root);
          }
        } catch {
          this.transition(taskId, 'baseline_required');
          this.emit(taskId, 'git', 'git.baseline-required', { files: projectChanges, message: 'Existing external changes must be reviewed and committed separately before this task can modify the project.' });
          return;
        }
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

      let specialistContext = '';
      if (!recovery && classification.codexRole !== 'none' && models.codex && models.codexEffort) {
        this.transition(taskId, 'reviewing');
        this.emit(taskId, 'codex', 'agent.started', { role: classification.codexRole, model: models.codex, effort: models.codexEffort });
        specialistContext = await runCodexAnalysis({ root: project.root, prompt: task.prompt, role: classification.codexRole, model: models.codex, effort: models.codexEffort, riderAvailable: riderFor('codex'), signal, onOutput: (chunk) => this.stream(taskId, 'codex', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'codex', usage) });
        this.emit(taskId, 'codex', 'agent.completed', { role: classification.codexRole, summary: specialistContext.slice(-4000) });
      }

      this.transition(taskId, 'running');
      this.emit(taskId, 'antigravity', 'agent.started', { model: models.antigravity, effort: models.antigravityEffort });
      const implementationContext = [specialistContext, recoveryReason ? `The previous automatic run paused for this reason:\n${recoveryReason}` : ''].filter(Boolean).join('\n\n');
      const contextUsed = antigravityAccount.workspace && samePath(antigravityAccount.workspace, project.root) ? antigravityAccount.context?.usedPercent : null;
      const priorInputTokens = latestAntigravityInputTokens(this.store, project.id, session.id, taskId);
      const rotateConversation = contextUsed !== null && contextUsed !== undefined && contextUsed >= 80 || priorInputTokens !== null && priorInputTokens >= 200_000;
      const conversationId = rotateConversation ? null : session.antigravityConversationId;
      if (!conversationId && session.antigravityConversationId && rotateConversation) this.emit(taskId, 'system', 'routing.adjustment', { message: contextUsed !== null && contextUsed !== undefined && contextUsed >= 80 ? `Antigravity context is ${contextUsed.toFixed(1)}% used. Orchestra started a fresh provider conversation while preserving the local session summary.` : `The previous Antigravity turn used ${priorInputTokens?.toLocaleString()} input tokens. Orchestra started a fresh provider conversation while preserving the local session summary.` });
      let agentResult = await runAntigravityWithFailover({ root: project.root, prompt: task.prompt, model: models.antigravity, effort: models.antigravityEffort, mutating: classification.mutating, conversationId, context: implementationContext, recovery, riderAvailable: riderFor('antigravity'), signal, onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage) }, 'implementation');
      let hadIncompleteAgentRun = agentResult.incomplete;
      if (agentResult.conversationId) this.store.setConversationId(session.id, agentResult.conversationId);
      if (agentResult.warning) this.emit(taskId, 'antigravity', 'warning', { message: agentResult.warning });
      if (agentResult.incomplete) this.emit(taskId, 'system', 'task.provider-recovery', { message: `Antigravity ended with status ${agentResult.terminalStatus || 'ERROR'} during implementation. Orchestra is inspecting the working tree and will either retry automatically or continue preserved changes into Codex review.`, provider: 'antigravity', status: agentResult.terminalStatus });
      else this.emit(taskId, 'antigravity', 'agent.completed', { summary: agentResult.text.slice(-5000) });

      if (classification.mutating) {
        let progress = implementationChangeState(status.head, await getGitStatus(project.root));
        if (progress === 'committed') throw new Error('Antigravity committed project changes directly. Orchestra stopped because it can no longer review and finalize the complete uncommitted change set safely.');
        const maxImplementationRetries = 2;
        for (let retryAttempt = 1; progress === 'none' && retryAttempt <= maxImplementationRetries; retryAttempt += 1) {
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
          this.emit(taskId, 'system', 'task.implementation-retry', { attempt: retryAttempt, maxAttempts: maxImplementationRetries, message: `Orchestra is starting fresh foreground implementation attempt ${retryAttempt + 1} with Gemma/Codex recovery guidance.` });
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
          if (agentResult.incomplete) this.emit(taskId, 'system', 'task.provider-recovery', { message: `Antigravity's foreground retry ended with status ${agentResult.terminalStatus || 'ERROR'}. Orchestra will continue with any preserved diff or the next bounded failover attempt.`, provider: 'antigravity', status: agentResult.terminalStatus, attempt: retryAttempt });
          else this.emit(taskId, 'antigravity', 'agent.completed', { retry: retryAttempt, summary: agentResult.text.slice(-5000) });
          progress = implementationChangeState(status.head, await getGitStatus(project.root));
          if (progress === 'committed') throw new Error('Antigravity committed project changes directly during the automatic retry. Orchestra stopped because it cannot safely review and finalize that hidden change set.');
        }
        if (progress === 'none') throw new Error(`Implementation produced no project file changes after ${maxImplementationRetries + 1} foreground attempts. Orchestra exhausted bounded automatic alternatives without a reviewable diff.`);
      }

      if (!classification.mutating && evidence) agentResult.text = await this.postflight(taskId, project.root, task.prompt, agentResult.text, evidence);

      if (classification.mutating) {
        const afterAgent = await getGitStatus(project.root);
        if (!afterAgent.isGit) throw new Error('The project stopped being a Git repository during implementation. Orchestra will not accept or finalize unreviewable changes.');
        const agentChanges = afterAgent.files.filter((file) => !isOrchestraInternalPath(file.path));
        if (agentChanges.length) {
          const reviewBaseSha = status.head;
          // Checkpoint initial implementation so changes are safely recorded
          try {
            const checkpointDiff = await getDiff(project.root, 35_000);
            const checkpointSummary = await summarizeChanges(checkpointDiff, task.prompt);
            const checkpointPaths = agentChanges.map((file) => file.path);
            const checkpointSha = await commitPaths(project.root, checkpointPaths, safeCommitTitle(checkpointSummary.title, 'feat: implement initial task changes'), checkpointSummary.summary);
            this.emit(taskId, 'git', 'git.commit', { kind: 'checkpoint', sha: checkpointSha, title: checkpointSummary.title, files: checkpointPaths });
            this.emit(taskId, 'gemma', 'agent.completed', { phase: 'checkpoint-commit', sha: checkpointSha });
          } catch (error) {
            this.emit(taskId, 'git', 'warning', { message: `The safety checkpoint could not be created; Orchestra will review the uncommitted change set from the original base. ${error instanceof Error ? error.message : String(error)}` });
          }

          let previousFindings = '';
          let previousReview = '';
          let previousRepairChanged = true;
          let noProgressEscalations = 0;
          let verificationPassed = false;
          const maxRepairAttempts = 3;
          for (let cycle = 0; cycle <= maxRepairAttempts; cycle += 1) {
            const reviewStatus = await getGitStatus(project.root);
            const changedFiles = (reviewBaseSha
              ? await getChangedFilesFromBase(project.root, reviewBaseSha)
              : reviewStatus.files.map((file) => file.path))
              .filter((path) => !isOrchestraInternalPath(path));
            const diff = reviewBaseSha ? await getDiffFromBase(project.root, reviewBaseSha, 80_000) : await getDiff(project.root, 80_000);
            if (!changedFiles.length || !diff.trim()) {
              throw new Error('Orchestra could not construct a reviewable base-to-head change set after implementation. The task was stopped before spending review quota on an empty evidence packet.');
            }
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
              if (!sanity.passed && sanity.issues.length) {
                this.emit(taskId, 'gemma', 'warning', { message: `Local sanity check noted issues: ${sanity.issues.join('; ')}` });
              }
            } catch { /* non-blocking */ }
            const profile = selectReviewProfile({ request: task.prompt, cycle, changedFileCount: changedFiles.length, triageRisk: triage.risk, repeatedFindings: cycle > 0 && !previousRepairChanged, codexRemaining, quotaPolicy });
            this.emit(taskId, 'system', 'routing.adjustment', { message: `Review cycle ${cycle + 1} uses ${profile.model} (${profile.reason}).`, reviewModel: profile.model, reviewEffort: profile.effort, reason: profile.reason });
            const reviewPacket = buildReviewPacket({ request: task.prompt, changedFiles, diff, implementationSummary: agentResult.text, triage, previousReview });
            this.transition(taskId, 'reviewing');
            this.emit(taskId, 'codex', 'agent.started', { role: 'review', model: profile.model, effort: profile.effort, cycle: cycle + 1, changedFiles: changedFiles.length, triageRisk: triage.risk });
            let review = await runCodexReview({ root: project.root, model: profile.model, effort: profile.effort, reviewPacket, riderAvailable: riderFor('codex'), signal, onOutput: (chunk) => this.stream(taskId, 'codex', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'codex', usage) });
            const reviewResult = extractCodexReviewVerdict(review);
            let blocked = reviewResult.blocked;
            this.emit(taskId, 'codex', 'agent.completed', { role: 'review', blocked, verdict: reviewResult.verdict, model: profile.model, cycle: cycle + 1, summary: review.slice(-5000) });
            if (!blocked) {
              this.transition(taskId, 'verifying');
              let verificationFailure = '';
              let verification: Array<{ command: string; code: number; output: string }> = [];
              try {
                verification = await verifyProject(project.root, signal);
                this.emit(taskId, 'verification', 'verification.result', { results: verification });
                verificationFailure = describeVerificationFailure(verification);
              } catch (error) {
                verificationFailure = error instanceof Error ? error.message : String(error);
                this.emit(taskId, 'verification', 'warning', { message: `Verification infrastructure failed; Orchestra is routing the failure through automatic repair instead of stopping. ${verificationFailure}` });
              }
              if (!verificationFailure) {
                verificationPassed = true;
                break;
              }
              blocked = true;
              const failedItem = verification.find((item) => item.code !== 0);
              const failedCmd = failedItem?.command || 'verification';
              this.emit(taskId, 'gemma', 'agent.started', { phase: 'verification-distillation', command: failedCmd });
              const distilled = await distillVerificationErrors(verificationFailure, failedCmd);
              this.emit(taskId, 'gemma', 'agent.completed', { phase: 'verification-distillation', summary: distilled.summary, findingCount: distilled.findings.length });
              review = `VERDICT: BLOCK\n\nOrchestra deterministic verification failed after Codex review passed.\n\n${distilled.repairPromptChunk}`;
              this.emit(taskId, 'system', 'task.model-takeover', { message: `Deterministic verification failed. Gemma distilled ${distilled.findings.length} actionable failure finding(s) for Antigravity repair.`, from: 'verification', to: 'antigravity-repair', cycle: cycle + 1 });
            }
            const findings = reviewFingerprint(review);
            const repeatedWithoutProgress = Boolean(previousFindings && findings === previousFindings && !previousRepairChanged);
            if (repeatedWithoutProgress) {
              noProgressEscalations += 1;
              if (noProgressEscalations > 1) {
                this.transition(taskId, 'review_disputed');
                this.emit(taskId, 'system', 'task.review-disputed', {
                  reason: 'Repeated repairs produced no progress on the same review blockers.',
                  findings,
                  reviewSummary: review.slice(-3000),
                  changedFiles,
                  message: 'Codex confirmed the same blockers after multiple repairs with no diff progress. You can approve the preserved diff or steer the repair.',
                });
                return;
              }
              this.emit(taskId, 'system', 'task.model-takeover', { message: 'Codex confirmed the same blockers after a no-progress repair. Orchestra is giving the escalated review to a fresh Antigravity conversation for one alternate foreground repair before requiring attention.', from: 'codex-review', to: 'antigravity-fresh-repair', cycle: cycle + 1 });
            } else noProgressEscalations = 0;
            if (cycle === maxRepairAttempts) {
              this.transition(taskId, 'review_disputed');
              this.emit(taskId, 'system', 'task.review-disputed', {
                reason: `Automatic repair reached its limit of ${maxRepairAttempts} cycles.`,
                findings,
                reviewSummary: review.slice(-3000),
                changedFiles,
                message: `Automatic repair paused after ${maxRepairAttempts} cycles without full consensus. You can approve and commit the preserved diff directly, or provide specific repair guidance.`,
              });
              return;
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
            this.emit(taskId, 'system', 'task.repair-progress', { attempt: cycle + 1, maxAttempts: maxRepairAttempts, changed: previousRepairChanged });
          }
          if (!verificationPassed) throw new Error('Automatic review and repair ended without a passing deterministic verification result.');

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
      if (signal.aborted) return this.cancel(taskId);
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

  private complete(taskId: string, result: string, agent: 'gemma' | 'antigravity' | 'codex') {
    const task = requireTask(this.store, taskId);
    const state: TaskState = task.pushStatus === 'unpushed' ? 'completed_unpushed' : 'completed';
    this.store.updateTask(taskId, { state, result });
    this.store.addMessage({ sessionId: task.sessionId, taskId, role: 'assistant', agent, content: result || 'Task completed.' });
    this.emit(taskId, 'system', 'task.state', { state, result });
  }

  private async finalizeGit(taskId: string, project: Project, request: string, _classification: TaskClassification, _models: ModelSelection) {
    await this.gitFinalization.finalize(
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

export function evaluateRunHealth(state: TaskState, processAlive: boolean, inactiveMs: number): RunMonitor['health'] {
  if (state === 'completed' || state === 'completed_unpushed') return 'complete';
  if (state === 'recovery_required' || state === 'baseline_required' || state === 'review_disputed') return 'needs_attention';
  if (state === 'failed' || state === 'cancelled') return 'failed';
  if (!processAlive || inactiveMs >= 5 * 60_000) return 'possibly_stalled';
  if (inactiveMs >= 90_000) return 'waiting';
  return 'active';
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
function minimumRemaining(value: { quotas?: Array<{ remainingPercent: number | null }> }) {
  const numbers = (value.quotas || []).map((item) => item.remainingPercent).filter((item): item is number => item !== null && Number.isFinite(item));
  return numbers.length ? Math.min(...numbers) : null;
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
function agentForState(state: TaskState): AgentName {
  if (state === 'reviewing') return 'codex';
  if (state === 'running' || state === 'recovering') return 'antigravity';
  if (state === 'verifying') return 'verification';
  if (state === 'summarizing') return 'gemma';
  if (state === 'committing' || state === 'pushing') return 'git';
  return 'system';
}
function monitorSummary(input: { state: TaskState; health: RunMonitor['health']; currentAgent: AgentName; inactiveMs: number; reviewCycle: number; repairAttempt: number; changedFiles: number }) {
  const activity = input.inactiveMs < 60_000 ? `${Math.round(input.inactiveMs / 1000)} seconds` : `${Math.round(input.inactiveMs / 60_000)} minutes`;
  const cycle = input.reviewCycle ? ` Review cycle ${input.reviewCycle}.` : '';
  const repair = input.repairAttempt ? ` ${input.repairAttempt} automatic repair attempt${input.repairAttempt === 1 ? '' : 's'} completed.` : '';
  return `${input.currentAgent} is in ${input.state.replaceAll('_', ' ')}. Last activity was ${activity} ago. Health: ${input.health.replaceAll('_', ' ')}.${cycle}${repair} ${input.changedFiles} uncommitted project file${input.changedFiles === 1 ? '' : 's'} detected.`;
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
