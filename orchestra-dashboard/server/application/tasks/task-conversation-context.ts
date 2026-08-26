import { config } from '../../config.js';
import type { Store } from '../../db.js';
import type { AgentName, Session } from '../../types.js';
import type { TaskEventType } from '../../domain/index.js';
import type { RepositoryEvidence } from '../../evidence.js';
import { getActiveLmStudioModel, summarizeConversation, validateAgentResponse } from '../../agents.js';

type EmitTaskEvent = (taskId: string, agent: AgentName, type: TaskEventType, payload: unknown) => void;

/** Owns bounded conversation memory and read-only response validation. */
export class TaskConversationContext {
  constructor(private readonly store: Store, private readonly emit: EmitTaskEvent) {}

  async prepare(taskId: string, session: Session) {
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

  async validate(taskId: string, root: string, prompt: string, response: string, evidence: RepositoryEvidence) {
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
}
