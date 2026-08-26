import { config } from '../../config.js';
import type { Store } from '../../db.js';
import type { AgentName, ModelSelection, Project, Session, TaskClassification, TaskRecord } from '../../types.js';
import type { TaskEventType } from '../../domain/index.js';
import { collectRepositoryEvidence, type RepositoryEvidence } from '../../evidence.js';
import { getDiff, getGitStatus, getRecentCommits } from '../../git.js';
import { getMcpStatus, type McpStatus } from '../../mcp.js';
import { formatDirectGitStatusAnswer, isDirectGitStatusQuestion } from '../gemma/direct-chat-contract.js';
import { getActiveLmStudioModel, runAntigravity, runCodexAnalysis, runGemmaDirectChat } from '../../agents.js';

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

    const activeGemmaModel = await getActiveLmStudioModel();
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

    if (directAgent === 'gemma') {
      this.runtime.emit(task.id, 'gemma', 'agent.started', { phase: 'direct-chat', model: chosenGemma });
      const asksAboutRepo = /\b(?:code|file|repo|git|commit|diff|build|test|bug|error|function|class|method|import|export|component|server|src|package|docs|orchestra|agent|architecture|review|why|how)\b/i.test(task.prompt);
      let evidence: RepositoryEvidence | undefined;
      if (asksAboutRepo) {
        const [status, commits, diff] = await Promise.all([getGitStatus(project.root), getRecentCommits(project.root, 5), getDiff(project.root, 4_000)]);
        evidence = collectRepositoryEvidence(project.root, task.prompt, status, commits, diff, 8_000);
      }
      const answer = await runGemmaDirectChat({
        root: project.root, model: chosenGemma, prompt: task.prompt, evidence, signal,
        onOutput: (chunk) => this.runtime.stream(task.id, 'gemma', chunk),
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
        root: project.root, prompt: task.prompt, role: 'Direct Architecture & Code Consultation', model, effort: directEffort,
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
      root: project.root,
      prompt: `Answer the user inquiry directly in conversational read-only mode. Do not modify files:\n\n${task.prompt}`,
      model: chosenAntigravity, effort: antigravityEffort, mutating: false, conversationId: session.antigravityConversationId,
      riderAvailable: riderFor('antigravity'), signal,
      onOutput: (chunk) => this.runtime.stream(task.id, 'antigravity', chunk),
      onUsage: (usage) => this.runtime.recordProviderTelemetry(task.id, 'antigravity', usage),
    });
    this.runtime.emit(task.id, 'antigravity', 'agent.completed', { role: 'direct-chat', result: result.text });
    this.runtime.complete(task.id, result.text, 'antigravity');
    return { handled: true, activeGemmaModel };
  }
}
