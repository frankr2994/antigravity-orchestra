import { config } from '../../config.js';
import type { Store } from '../../db.js';
import type { AgentName, ModelSelection, Project, Session, TaskClassification, TaskRecord } from '../../types.js';
import type { TaskEventType } from '../../domain/index.js';
import { getDiff, getGitStatus, getRecentCommits } from '../../git.js';
import { getMcpStatus, type McpStatus } from '../../mcp.js';
import { formatDirectGitStatusAnswer, isDirectGitStatusQuestion } from '../gemma/direct-chat-contract.js';
import { runAntigravity, runCodexAnalysis, runGemmaDirectChat } from '../../agents.js';
import { getActiveLmStudioModelInfo, getInstalledLmStudioModels } from '../../lmstudio.js';
import { buildProjectOverview } from '../../infrastructure/filesystem/project-read-tools.js';
import { collectRepositoryEvidence, type RepositoryEvidence } from '../../evidence.js';
import { buildDirectSessionContext, deterministicDirectProjectAnswer, directProjectAccessInstruction, requireReadableProjectRoot, shouldEnableProjectReadTools, shouldRequireProjectReadTool } from '../context/direct-project-access.js';

export interface DirectTaskRuntime {
  transition(taskId: string, state: 'running'): void;
  emit(taskId: string, agent: AgentName, type: TaskEventType, payload: unknown): void;
  complete(taskId: string, result: string, agent: AgentName): void;
  stream(taskId: string, agent: AgentName, chunk: string): void;
  recordProviderTelemetry(taskId: string, agent: 'antigravity' | 'codex', value: unknown): void;
  recordLocalProviderTelemetry(taskId: string, usage: Record<string, number>): void;
}

export class DirectTaskExecutor {
  constructor(private readonly store: Store, private readonly runtime: DirectTaskRuntime) {}

  async execute(input: {
    task: TaskRecord;
    project: Project;
    session: Session;
    classification: TaskClassification;
    signal: AbortSignal;
  }): Promise<{ handled: boolean; activeGemmaModel: string }> {
    const { task, project, session, classification, signal } = input;
    const projectRoot = requireReadableProjectRoot(project.root);
    if (classification.executionMode === 'direct' && (classification.directAgent || 'gemma') === 'gemma' && isDirectGitStatusQuestion(task.prompt)) {
      const selectedModel = (classification as TaskClassification & { directModel?: string }).directModel || config.lmStudioModel;
      const directModels: ModelSelection = {
        primary: 'gemma', gemma: selectedModel, antigravity: 'gemini-3.7-flash-high', antigravityEffort: 'high', codex: null, codexEffort: null,
      };
      this.store.updateTask(task.id, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(directModels) });
      this.runtime.transition(task.id, 'running');
      this.runtime.emit(task.id, 'system', 'agent.started', { phase: 'direct-git-status', message: 'Reading the selected project Git status directly.' });
      const status = await getGitStatus(project.root);
      const answer = formatDirectGitStatusAnswer(project.root, status);
      this.runtime.emit(task.id, 'system', 'agent.completed', { phase: 'direct-git-status', isGit: status.isGit, changedFiles: status.files.length });
      this.runtime.complete(task.id, answer, 'system');
      return { handled: true, activeGemmaModel: selectedModel };
    }

    if (classification.executionMode === 'direct') {
      const directAgent = classification.directAgent || 'gemma';
      const deterministic = deterministicDirectProjectAnswer(projectRoot, task.prompt, directAgent);
      if (deterministic) {
        const directModel = (classification as TaskClassification & { directModel?: string }).directModel || null;
        const requestedEffort = (classification as TaskClassification & { directEffort?: string }).directEffort;
        const directEffort: 'low' | 'medium' | 'high' | 'xhigh' = ['low', 'medium', 'high', 'xhigh'].includes(requestedEffort || '')
          ? requestedEffort as 'low' | 'medium' | 'high' | 'xhigh'
          : 'high';
        const antigravityEffort: 'low' | 'medium' | 'high' = directEffort === 'xhigh' ? 'high' : directEffort;
        const chosenAntigravity = directAgent === 'antigravity' ? (directModel || 'gemini-3.7-flash-high') : 'gemini-3.7-flash-high';
        const chosenCodex = directAgent === 'codex' ? (directModel || 'gpt-5.6-sol') : null;
        const chosenGemma = directAgent === 'gemma' ? (directModel || config.lmStudioModel) : config.lmStudioModel;
        const directModels: ModelSelection = {
          primary: directAgent,
          gemma: chosenGemma,
          antigravity: chosenAntigravity,
          antigravityEffort: directAgent === 'antigravity' ? antigravityEffort : 'high',
          codex: chosenCodex,
          codexEffort: directAgent === 'codex' ? directEffort : null,
        };
        this.store.updateTask(task.id, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(directModels) });
        this.runtime.transition(task.id, 'running');
        this.runtime.emit(task.id, 'system', 'agent.completed', { phase: deterministic.phase, projectRoot, requestedAgent: directAgent });
        this.runtime.complete(task.id, deterministic.answer, 'system');
        return { handled: true, activeGemmaModel: directModels.gemma || config.lmStudioModel };
      }
    }

    const activeGemma = await getActiveLmStudioModelInfo();
    const activeGemmaModel = activeGemma.id;
    if (classification.executionMode !== 'direct') return { handled: false, activeGemmaModel };

    const directAgent = classification.directAgent || 'gemma';
    const directModel = (classification as TaskClassification & { directModel?: string }).directModel || null;
    const requestedEffort = (classification as TaskClassification & { directEffort?: string }).directEffort;
    const directEffort: 'low' | 'medium' | 'high' | 'xhigh' = ['low', 'medium', 'high', 'xhigh'].includes(requestedEffort || '')
      ? requestedEffort as 'low' | 'medium' | 'high' | 'xhigh'
      : 'high';
    const antigravityEffort: 'low' | 'medium' | 'high' = directEffort === 'xhigh' ? 'high' : directEffort;
    const chosenAntigravity = directAgent === 'antigravity' ? (directModel || 'gemini-3.7-flash-high') : 'gemini-3.7-flash-high';
    const chosenCodex = directAgent === 'codex' ? (directModel || 'gpt-5.6-sol') : null;
    const chosenGemma = directAgent === 'gemma' ? (directModel || activeGemmaModel) : activeGemmaModel;
    const directModels: ModelSelection = {
      primary: directAgent,
      gemma: chosenGemma,
      antigravity: chosenAntigravity,
      antigravityEffort: directAgent === 'antigravity' ? antigravityEffort : 'high',
      codex: chosenCodex,
      codexEffort: directAgent === 'codex' ? directEffort : null,
    };
    this.store.updateTask(task.id, { title: classification.title, classification: JSON.stringify(classification), models: JSON.stringify(directModels) });
    this.runtime.transition(task.id, 'running');

    let mcpStatus: McpStatus | null = null;
    try { mcpStatus = await getMcpStatus(); } catch { /* Direct chat remains available without Rider. */ }
    const riderFor = (agent: keyof McpStatus['agents']) => mcpStatus?.agents[agent].available === true;
    const sessionContext = buildDirectSessionContext(this.store.listMessages(session.id), task.id);

    if (directAgent === 'gemma') {
      this.runtime.emit(task.id, 'gemma', 'agent.started', { phase: 'direct-chat', model: chosenGemma });
      const installedModels = await getInstalledLmStudioModels().catch(() => []);
      const selectedModelInfo = installedModels.find((m) => m.id === chosenGemma);
      const modelCapabilities = selectedModelInfo?.capabilities ?? (chosenGemma === activeGemma.id ? activeGemma.capabilities : undefined);
      const modelSupportsTools = Array.isArray(modelCapabilities)
        ? modelCapabilities.some((c) => /tool|function/i.test(c))
        : true;
      const projectToolsEnabled = modelSupportsTools && shouldEnableProjectReadTools(task.prompt);
      const projectToolRequired = modelSupportsTools && shouldRequireProjectReadTool(task.prompt);
      const asksAboutGit = /\b(?:git\s+(?:status|diff|log|branch|commits?|history)|git\b|recent\s+commits?|last\s+commit|commit\s+history|uncommitted\s+changes?|working[- ]tree\s+diff|repo\s+status|current\s+branch)\b/i.test(task.prompt)
        || (/\b(?:diff|commits?|uncommitted)\b/i.test(task.prompt) && !/\b(?:history\s+of|changes?\s+in\s+[A-Z]|in\s+general)\b/i.test(task.prompt));
      let gitEvidence = '';
      if (asksAboutGit) {
        try {
          const [gitStatus, commits, diff] = await Promise.all([
            getGitStatus(projectRoot),
            getRecentCommits(projectRoot, 5),
            getDiff(projectRoot, 8_000),
          ]);
          const gitParts = [
            `## Git Snapshot\nRepository: ${gitStatus.isGit}\nBranch: ${gitStatus.branch || 'unknown'}\nHEAD: ${gitStatus.head || 'unknown'}\nDirty: ${gitStatus.dirty}\nChanged paths: ${gitStatus.files.slice(0, 80).map((file) => file.path).join(', ') || 'none'}`,
            commits ? `## Recent commit history:\n${commits}` : '',
            diff ? `## Uncommitted working-tree diff:\n${diff.slice(0, 8_000)}` : '',
          ].filter(Boolean);
          gitEvidence = gitParts.join('\n\n');
        } catch { /* Non-git project or git error */ }
      }
      let evidence: RepositoryEvidence | undefined;
      if (!modelSupportsTools && shouldEnableProjectReadTools(task.prompt)) {
        let gitStatus;
        let commits;
        let diff;
        try {
          [gitStatus, commits, diff] = await Promise.all([
            getGitStatus(projectRoot),
            getRecentCommits(projectRoot, 5),
            getDiff(projectRoot, 8_000),
          ]);
        } catch { /* Non-git project or git error */ }
        evidence = collectRepositoryEvidence(projectRoot, task.prompt, gitStatus, commits, diff, 24_000);
      } else {
        const needsOverview = shouldRequireProjectReadTool(task.prompt);
        const overview = needsOverview ? buildProjectOverview(projectRoot) : '';
        const combinedEvidence = [overview, gitEvidence].filter(Boolean).join('\n\n');
        evidence = combinedEvidence
          ? { root: projectRoot, text: combinedEvidence, files: [], includedFiles: [], characterCount: combinedEvidence.length, estimatedTokens: Math.ceil(combinedEvidence.length / 4), truncated: false }
          : undefined;
      }
      const promptText = projectToolsEnabled
        ? `${directProjectAccessInstruction(projectRoot, 'gemma')}\n\nUser question:\n${task.prompt}`
        : task.prompt;
      const selectedContextLength = selectedModelInfo?.state === 'loaded' && typeof selectedModelInfo.loadedContextLength === 'number'
        ? selectedModelInfo.loadedContextLength
        : (chosenGemma === activeGemma.id ? activeGemma.contextLength : undefined);
      const answer = await runGemmaDirectChat({
        root: projectRoot, model: chosenGemma, prompt: promptText,
        evidence,
        sessionContext, signal, enableProjectTools: projectToolsEnabled, requireProjectToolUse: projectToolRequired,
        modelSupportsTools, capabilities: modelCapabilities,
        contextLength: selectedContextLength,
        onOutput: (chunk) => this.runtime.stream(task.id, 'gemma', chunk),
        onToolActivity: (activity) => this.runtime.emit(task.id, 'gemma', 'mcp.tool', { ...activity, message: `Gemma project read tool ${activity.tool} ${activity.status}.` }),
        onUsage: (usage) => this.runtime.recordLocalProviderTelemetry(task.id, usage),
      });
      this.runtime.emit(task.id, 'gemma', 'agent.completed', { phase: 'direct-chat', result: answer });
      this.runtime.complete(task.id, answer, 'gemma');
      return { handled: true, activeGemmaModel };
    }
    if (directAgent === 'codex') {
      const model = chosenCodex || 'gpt-5.6-sol';
      this.runtime.emit(task.id, 'codex', 'agent.started', { role: 'direct-chat', model, effort: directEffort });
      const answer = await runCodexAnalysis({
        root: projectRoot, prompt: task.prompt, role: 'Direct Architecture & Code Consultation', model, effort: directEffort, sessionContext,
        riderAvailable: riderFor('codex'), signal,
        onOutput: (chunk) => this.runtime.stream(task.id, 'codex', chunk),
        onUsage: (usage) => this.runtime.recordProviderTelemetry(task.id, 'codex', usage),
      });
      this.runtime.emit(task.id, 'codex', 'agent.completed', { role: 'direct-chat', summary: answer.slice(-3000) });
      this.runtime.complete(task.id, answer, 'codex');
      return { handled: true, activeGemmaModel };
    }

    this.runtime.emit(task.id, 'antigravity', 'agent.started', { role: 'direct-chat', model: chosenAntigravity });
    const result = await runAntigravity({
      root: projectRoot,
      prompt: `Answer the user inquiry directly in conversational read-only mode. Do not modify files:\n\n${task.prompt}`,
      model: chosenAntigravity, effort: antigravityEffort, mutating: false, conversationId: session.antigravityConversationId,
      riderAvailable: riderFor('antigravity'), sessionContext, signal,
      onOutput: (chunk) => this.runtime.stream(task.id, 'antigravity', chunk),
      onUsage: (usage) => this.runtime.recordProviderTelemetry(task.id, 'antigravity', usage),
    });
    this.runtime.emit(task.id, 'antigravity', 'agent.completed', { role: 'direct-chat', result: result.text });
    this.runtime.complete(task.id, result.text, 'antigravity');
    return { handled: true, activeGemmaModel };
  }
}
