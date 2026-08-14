import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import type { Store } from './db.js';
import type { AgentName, ModelSelection, Project, RunMonitor, Session, TaskClassification, TaskEvent, TaskRecord, TaskState } from './types.js';
import { answerRepositoryQuestion, buildReviewPacket, classifyTask, listAntigravityModels, resolveAntigravityModel, runAntigravity, runCodexAnalysis, runCodexReview, selectModels, selectReviewProfile, shouldAttemptGemmaAnswer, summarizeChanges, summarizeConversation, triageReview, validateAgentResponse, type ReviewTriage } from './agents.js';
import { collectRepositoryEvidence, type RepositoryEvidence } from './evidence.js';
import { commitPaths, connectGitHubRemote, extractGitHubRemoteUrl, getDiff, getGitStatus, pushCurrent, safeCommitTitle } from './git.js';
import { initializeGreenfieldRepository, isOrchestraInternalPath, onboardProject } from './projects.js';
import { verifyProject } from './verification.js';
import { readAntigravityTranscript, readAntigravityUsage, readCodexUsage } from './observability.js';
import { getMcpStatus, type McpStatus } from './mcp.js';

export class TaskManager {
  private readonly bus = new EventEmitter();
  private readonly queue: string[] = [];
  private readonly runningProjects = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly contextWarnings = new Set<string>();
  private antigravityModels: string[] = [];

  constructor(private readonly store: Store, private readonly maxGlobal = 2) {
    this.bus.setMaxListeners(100);
    void this.refreshModels();
  }

  async refreshModels() { this.antigravityModels = await listAntigravityModels(); }

  enqueue(taskId: string) {
    if (!this.queue.includes(taskId) && !this.controllers.has(taskId)) this.queue.push(taskId);
    this.drain();
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void) {
    const name = `task:${taskId}`;
    this.bus.on(name, listener);
    return () => this.bus.off(name, listener);
  }

  cancel(taskId: string) {
    const task = requireTask(this.store, taskId);
    if (['completed', 'completed_unpushed', 'failed', 'cancelled'].includes(task.state)) return;
    const index = this.queue.indexOf(taskId);
    if (index >= 0) this.queue.splice(index, 1);
    this.controllers.get(taskId)?.abort();
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
    if (this.controllers.has(taskId)) throw new Error('This task is already running. Open its original conversation to follow progress.');
    const project = requireProject(this.store, task.projectId);
    const status = await getGitStatus(project.root);
    if (!status.isGit) throw new Error('This project is not a Git repository.');
    const baselineFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (baselineFiles.length) {
      const diff = await getDiff(project.root);
      const summary = await summarizeChanges(diff, 'Review and preserve changes that existed before the dashboard task.');
      appendHandoff(project.root, summary.summary, 'Baseline changes');
      const updated = await getGitStatus(project.root);
      const paths = updated.files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path));
      if (!paths.length) throw new Error('No project files remained after excluding Orchestra internal state from the baseline.');
      const sha = await commitPaths(project.root, paths, safeCommitTitle(summary.title, 'chore: preserve existing changes'), summary.summary);
      const pushed = await pushCurrent(project.root);
      this.store.createGitOperation(project.id, task.id, 'baseline', sha, updated.branch, pushed.pushed ? 'pushed' : 'unpushed', pushed.error);
      this.emit(task.id, 'git', 'git.commit', { kind: 'baseline', sha });
      this.emit(task.id, 'git', 'git.push', pushed);
    }
    const latestProject = requireProject(this.store, project.id);
    const onboarding = await onboardProject(this.store, { ...latestProject, onboardingStatus: 'pending' });
    this.emit(task.id, 'system', 'project.onboarding', onboarding);
    this.store.updateTask(task.id, { state: 'queued', error: null });
    this.enqueue(task.id);
  }

  private drain() {
    while (this.controllers.size < this.maxGlobal) {
      const index = this.queue.findIndex((id) => {
        const task = this.store.getTask(id);
        return task && !this.runningProjects.has(task.projectId);
      });
      if (index < 0) break;
      const [taskId] = this.queue.splice(index, 1);
      const task = this.store.getTask(taskId);
      if (!task || task.state !== 'queued' && task.state !== 'recovering') continue;
      const controller = new AbortController();
      this.controllers.set(taskId, controller);
      this.runningProjects.add(task.projectId);
      void this.execute(taskId, controller.signal).finally(() => {
        this.controllers.delete(taskId);
        this.runningProjects.delete(task.projectId);
        this.drain();
      });
    }
  }

  activeTaskId(projectId: string) {
    for (const [taskId] of this.controllers) if (this.store.getTask(taskId)?.projectId === projectId) return taskId;
    return this.queue.map((taskId) => this.store.getTask(taskId)).find((task) => task?.projectId === projectId)?.id || null;
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
    const processAlive = this.controllers.has(taskId);
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
      this.transition(taskId, 'routing');
      const originalClassification = recovery ? parseTaskClassification(task.classification) : null;
      const classified = originalClassification
        ? { classification: originalClassification, source: 'recovery' as const, warning: undefined }
        : await classifyTask(task.prompt);
      const classification = classified.classification;
      if (classified.warning) this.emit(taskId, 'gemma', 'warning', { message: `Gemma classification unavailable; deterministic routing was used. ${classified.warning}` });
      else this.emit(taskId, 'gemma', 'agent.completed', { phase: 'classification', classification, recovered: recovery });
      if (!recovery && classification.localOperation === 'connect_git_remote') {
        const localModels: ModelSelection = { ...selectModels(classification), primary: 'gemma', gemma: config.lmStudioModel, codex: null, codexEffort: null };
        this.store.updateTask(taskId, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(localModels) });
        this.transition(taskId, 'preflight');
        if (project.onboardingStatus === 'scope_warning') throw new Error('The selected directory contains nested Git repositories. Select the specific repository you want to connect.');
        const remoteUrl = findRecentGitHubUrl(this.store, session.id, task.prompt);
        if (!remoteUrl) throw new Error('Gemma identified a Git remote connection request, but no valid HTTPS GitHub repository URL was found in the recent conversation.');
        this.transition(taskId, 'running');
        this.emit(taskId, 'gemma', 'agent.started', { phase: 'local-operation', operation: 'connect_git_remote', model: config.lmStudioModel });
        const connected = await connectGitHubRemote(project.root, remoteUrl);
        this.store.updateTask(taskId, { commitSha: connected.head, pushStatus: 'pushed' });
        this.store.createGitOperation(project.id, taskId, 'connect_remote', connected.head, connected.branch, 'pushed', null);
        this.emit(taskId, 'git', 'git.remote', connected);
        this.emit(taskId, 'git', 'git.push', { pushed: true, remote: connected.remote, branch: connected.branch });
        this.emit(taskId, 'gemma', 'agent.completed', { phase: 'local-operation', operation: 'connect_git_remote' });
        this.complete(taskId, `Connected this project to ${connected.remote} as \`origin\` and pushed \`${connected.branch}\` at commit \`${connected.head}\`.`, 'gemma');
        return;
      }
      let models: ModelSelection = { ...selectModels(classification, recovery ? 1 : 0), primary: 'antigravity', gemma: config.lmStudioModel };
      const [codexAccount, antigravityAccount] = await Promise.all([readCodexUsage(), readAntigravityUsage()]);
      const routingReasons: string[] = [];
      const antigravityRemaining = minimumRemaining(antigravityAccount);
      const codexRemaining = minimumRemaining(codexAccount);
      if (!recovery && classification.complexity === 'small' && antigravityRemaining !== null && antigravityRemaining <= 10 && models.antigravity === 'gemini-3.6-flash-high') {
        models = { ...models, antigravity: 'gemini-3.6-flash-medium', antigravityEffort: 'medium' };
        routingReasons.push(`Antigravity quota is ${antigravityRemaining.toFixed(1)}% remaining, so a small task was moved to Flash Medium.`);
      }
      if (!recovery && classification.complexity === 'small' && codexRemaining !== null && codexRemaining <= 10 && models.codex && models.codex !== 'gpt-5.6-luna') {
        models = { ...models, codex: 'gpt-5.6-luna', codexEffort: 'medium' };
        routingReasons.push(`Codex quota is ${codexRemaining.toFixed(1)}% remaining, so a small specialist task was moved to Luna.`);
      }
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
        this.transition(taskId, 'baseline_required');
        this.emit(taskId, 'git', 'git.baseline-required', { files: projectChanges, message: 'Existing changes must be reviewed and committed separately before this task can modify the project.' });
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
      let agentResult = await runAntigravity({ root: project.root, prompt: task.prompt, model: models.antigravity, effort: models.antigravityEffort, mutating: classification.mutating, conversationId, context: implementationContext, recovery, riderAvailable: riderFor('antigravity'), signal, onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage) });
      let hadIncompleteAgentRun = agentResult.incomplete;
      if (agentResult.conversationId) this.store.setConversationId(session.id, agentResult.conversationId);
      if (agentResult.warning) this.emit(taskId, 'antigravity', 'warning', { message: agentResult.warning });
      if (agentResult.incomplete) this.emit(taskId, 'system', 'task.provider-recovery', { message: `Antigravity ended with status ${agentResult.terminalStatus || 'ERROR'} during implementation. Orchestra is inspecting the working tree and will either retry automatically or continue preserved changes into Codex review.`, provider: 'antigravity', status: agentResult.terminalStatus });
      else this.emit(taskId, 'antigravity', 'agent.completed', { summary: agentResult.text.slice(-5000) });

      if (classification.mutating) {
        let progress = implementationChangeState(status.head, await getGitStatus(project.root));
        if (progress === 'committed') throw new Error('Antigravity committed project changes directly. Orchestra stopped because it can no longer review and finalize the complete uncommitted change set safely.');
        if (progress === 'none') {
          this.emit(taskId, 'system', 'task.implementation-retry', { attempt: 1, message: 'The first implementation turn produced no project changes. Orchestra is retrying automatically with explicit write instructions.' });
          agentResult = await runAntigravity({
            root: project.root,
            prompt: `The prior implementation turn produced no project file changes. Implement the original request now. Work directly in this foreground turn: do not invoke or wait for subagents, delegate the task, return another plan, request approval, or stop at analysis. Create or modify the necessary project files, run synchronous verification, and leave the complete changes uncommitted for Orchestra review.\n\nOriginal request:\n${task.prompt}`,
            model: models.antigravity,
            effort: 'high',
            mutating: true,
            conversationId: agentResult.incomplete ? null : agentResult.conversationId || session.antigravityConversationId,
            riderAvailable: riderFor('antigravity'),
            signal,
            onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk),
            onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage),
          });
          hadIncompleteAgentRun ||= agentResult.incomplete;
          if (agentResult.conversationId) this.store.setConversationId(session.id, agentResult.conversationId);
          if (agentResult.warning) this.emit(taskId, 'antigravity', 'warning', { message: agentResult.warning });
          if (agentResult.incomplete) this.emit(taskId, 'system', 'task.provider-recovery', { message: `Antigravity's foreground retry ended with status ${agentResult.terminalStatus || 'ERROR'}. Orchestra will continue with any preserved diff and independent review.`, provider: 'antigravity', status: agentResult.terminalStatus, attempt: 1 });
          else this.emit(taskId, 'antigravity', 'agent.completed', { retry: 1, summary: agentResult.text.slice(-5000) });
          progress = implementationChangeState(status.head, await getGitStatus(project.root));
          if (progress === 'committed') throw new Error('Antigravity committed project changes directly during the automatic retry. Orchestra stopped because it cannot safely review and finalize that hidden change set.');
          if (progress === 'none') throw new Error('Implementation produced no project file changes after an automatic retry. Orchestra did not mark the request complete; inspect the agent output or retry with a more specific implementation request.');
        }
      }

      if (!classification.mutating && evidence) agentResult.text = await this.postflight(taskId, project.root, task.prompt, agentResult.text, evidence);

      if (classification.mutating) {
        const afterAgent = await getGitStatus(project.root);
        if (!afterAgent.isGit) throw new Error('The project stopped being a Git repository during implementation. Orchestra will not accept or finalize unreviewable changes.');
        const agentChanges = afterAgent.files.filter((file) => !isOrchestraInternalPath(file.path));
        if (agentChanges.length) {
          let previousFindings = '';
          let previousReview = '';
          let previousRepairChanged = true;
          const maxRepairAttempts = 6;
          for (let cycle = 0; cycle <= maxRepairAttempts; cycle += 1) {
            const reviewStatus = await getGitStatus(project.root);
            const changedFiles = reviewStatus.files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path));
            const diff = await getDiff(project.root, 80_000);
            let triage: ReviewTriage = { risk: 'normal', summary: 'Local triage was unavailable; review the bounded diff directly.', focusFiles: [], concerns: [] };
            this.emit(taskId, 'gemma', 'agent.started', { phase: 'review-triage', cycle: cycle + 1, changedFiles: changedFiles.length });
            try {
              triage = await triageReview({ request: task.prompt, diff, changedFiles });
              this.emit(taskId, 'gemma', 'agent.completed', { phase: 'review-triage', cycle: cycle + 1, risk: triage.risk, focusFiles: triage.focusFiles, concerns: triage.concerns });
            } catch (error) {
              this.emit(taskId, 'gemma', 'warning', { message: `Local review triage was unavailable; Codex will receive the deterministic diff packet. ${error instanceof Error ? error.message : String(error)}` });
            }
            const profile = selectReviewProfile({ request: task.prompt, cycle, changedFileCount: changedFiles.length, triageRisk: triage.risk, repeatedFindings: cycle > 0 && !previousRepairChanged });
            this.emit(taskId, 'system', 'routing.adjustment', { message: `Review cycle ${cycle + 1} uses ${profile.model} (${profile.reason}).`, reviewModel: profile.model, reviewEffort: profile.effort, reason: profile.reason });
            const reviewPacket = buildReviewPacket({ request: task.prompt, changedFiles, diff, implementationSummary: agentResult.text, triage, previousReview });
            this.transition(taskId, 'reviewing');
            this.emit(taskId, 'codex', 'agent.started', { role: 'review', model: profile.model, effort: profile.effort, cycle: cycle + 1, changedFiles: changedFiles.length, triageRisk: triage.risk });
            const review = await runCodexReview({ root: project.root, model: profile.model, effort: profile.effort, reviewPacket, riderAvailable: riderFor('codex'), signal, onOutput: (chunk) => this.stream(taskId, 'codex', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'codex', usage) });
            const blocked = !/VERDICT:\s*PASS/i.test(review) || /VERDICT:\s*BLOCK/i.test(review);
            this.emit(taskId, 'codex', 'agent.completed', { role: 'review', blocked, model: profile.model, cycle: cycle + 1, summary: review.slice(-5000) });
            if (!blocked) break;
            const findings = reviewFingerprint(review);
            const repeatedWithoutProgress = Boolean(previousFindings && findings === previousFindings && !previousRepairChanged);
            if (repeatedWithoutProgress) throw new Error(`Automatic repair paused because Codex repeated the same blocking findings and the previous repair made no project changes.\n${review.slice(-3000)}`);
            if (cycle === maxRepairAttempts) throw new Error(`Automatic repair paused after ${maxRepairAttempts} repair attempts. The remaining findings require user direction or a different approach.\n${review.slice(-3000)}`);
            const beforeRepair = diffFingerprint(await getDiff(project.root));
            this.transition(taskId, 'running');
            const priorIncomplete = agentResult.incomplete;
            agentResult = await runAntigravity({ root: project.root, prompt: `Address every blocking finding in this Codex review, then rerun relevant verification. Perform the repair directly in this foreground turn; do not invoke or wait for subagents, delegate the repair, or pause before synchronous verification completes:\n\n${review}`, model: models.antigravity, effort: 'high', mutating: true, conversationId: priorIncomplete ? null : agentResult.conversationId || session.antigravityConversationId, riderAvailable: riderFor('antigravity'), signal, onOutput: (chunk) => this.stream(taskId, 'antigravity', chunk), onUsage: (usage) => this.recordProviderTelemetry(taskId, 'antigravity', usage) });
            hadIncompleteAgentRun ||= agentResult.incomplete;
            if (agentResult.warning) this.emit(taskId, 'antigravity', 'warning', { message: agentResult.warning });
            if (agentResult.incomplete) this.emit(taskId, 'system', 'task.provider-recovery', { message: `Antigravity's repair turn ended with status ${agentResult.terminalStatus || 'ERROR'}. Orchestra preserved the repair diff and is returning it to Codex review automatically.`, provider: 'antigravity', status: agentResult.terminalStatus, attempt: cycle + 1 });
            const afterRepair = diffFingerprint(await getDiff(project.root));
            previousRepairChanged = beforeRepair !== afterRepair;
            previousFindings = findings;
            previousReview = review;
            this.emit(taskId, 'system', 'task.repair-progress', { attempt: cycle + 1, maxAttempts: maxRepairAttempts, changed: previousRepairChanged });
          }

          this.transition(taskId, 'verifying');
          const verification = await verifyProject(project.root, signal);
          this.emit(taskId, 'verification', 'verification.result', { results: verification });
          const failed = verification.find((item) => item.code !== 0);
          if (failed) throw new Error(`Verification failed: ${failed.command}\n${failed.output.slice(-3000)}`);

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
    this.emit(taskId, 'gemma', 'agent.started', { phase: 'postflight-validation', model: config.lmStudioModel });
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

  private complete(taskId: string, result: string, agent: 'gemma' | 'antigravity') {
    const task = requireTask(this.store, taskId);
    const state: TaskState = task.pushStatus === 'unpushed' ? 'completed_unpushed' : 'completed';
    this.store.updateTask(taskId, { state, result });
    this.store.addMessage({ sessionId: task.sessionId, taskId, role: 'assistant', agent, content: result || 'Task completed.' });
    this.emit(taskId, 'system', 'task.state', { state, result });
  }

  private async finalizeGit(taskId: string, project: Project, request: string, _classification: TaskClassification, _models: ModelSelection) {
    const current = await getGitStatus(project.root);
    const projectFiles = current.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (!current.isGit || !projectFiles.length) return;
    this.transition(taskId, 'summarizing');
    const diff = await getDiff(project.root);
    const summary = await summarizeChanges(diff, request);
    appendHandoff(project.root, summary.summary, safeCommitTitle(summary.title));
    this.emit(taskId, 'gemma', 'agent.completed', { phase: 'handoff', ...summary });
    this.transition(taskId, 'committing');
    const updated = await getGitStatus(project.root);
    const paths = updated.files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path));
    if (!paths.length) return;
    const sha = await commitPaths(project.root, paths, safeCommitTitle(summary.title), summary.summary);
    this.store.updateTask(taskId, { commitSha: sha });
    this.emit(taskId, 'git', 'git.commit', { kind: 'task', sha, title: summary.title });
    this.transition(taskId, 'pushing');
    const pushed = await pushCurrent(project.root);
    this.store.updateTask(taskId, { pushStatus: pushed.pushed ? 'pushed' : 'unpushed' });
    this.store.createGitOperation(project.id, taskId, 'task', sha, updated.branch, pushed.pushed ? 'pushed' : 'unpushed', pushed.error);
    this.emit(taskId, 'git', 'git.push', pushed);
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

  private emit(taskId: string, agent: AgentName, type: string, payload: unknown) {
    const event = this.store.addEvent(taskId, agent, type, payload);
    this.bus.emit(`task:${taskId}`, event);
  }
}

export function recoveryDisposition(state: TaskState, taskAlreadyOwnsProject: boolean): 'start' | 'already_active' | 'reject' {
  if (state === 'failed' || state === 'recovery_required') return 'start';
  if (taskAlreadyOwnsProject) return 'already_active';
  return 'reject';
}

export function evaluateRunHealth(state: TaskState, processAlive: boolean, inactiveMs: number): RunMonitor['health'] {
  if (state === 'completed' || state === 'completed_unpushed') return 'complete';
  if (state === 'recovery_required' || state === 'baseline_required') return 'needs_attention';
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

export function appendHandoff(root: string, summary: string, title: string) {
  const path = join(root, 'docs', 'HANDOFF.md');
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8').trimEnd() : '# Project Handoff';
  const entry = `\n\n## [${new Date().toISOString()}] ${title}\n\n${summary.trim()}\n`;
  writeFileSync(path, `${existing}${entry}`, 'utf8');
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
