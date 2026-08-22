import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Session, ChatMessage } from '../../../domain/index.js';

function now() { return new Date().toISOString(); }

function mapSession(row: unknown): Session {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    title: String(r.title),
    antigravityConversationId: r.antigravity_conversation_id ? String(r.antigravity_conversation_id) : null,
    summary: r.summary ? String(r.summary) : null,
    summaryUpdatedAt: r.summary_updated_at ? String(r.summary_updated_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapMessage(row: unknown): ChatMessage {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    taskId: r.task_id ? String(r.task_id) : null,
    role: String(r.role) as ChatMessage['role'],
    agent: String(r.agent) as ChatMessage['agent'],
    content: String(r.content),
    createdAt: String(r.created_at),
  };
}

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(projectId: string, title = 'New conversation'): Session {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare('INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(id, projectId, title, stamp, stamp);
    this.db.prepare('UPDATE projects SET active_session_id=?,updated_at=? WHERE id=?').run(id, stamp, projectId);
    return this.getById(id)!;
  }

  getById(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return row ? mapSession(row) : null;
  }

  listByProject(projectId: string): Session[] {
    return this.db.prepare('SELECT * FROM sessions WHERE project_id=? ORDER BY updated_at DESC').all(projectId).map(mapSession);
  }

  setConversationId(sessionId: string, conversationId: string) {
    this.db.prepare('UPDATE sessions SET antigravity_conversation_id=?,updated_at=? WHERE id=?')
      .run(conversationId, now(), sessionId);
  }

  setSummary(sessionId: string, summary: string) {
    const stamp = now();
    this.db.prepare('UPDATE sessions SET summary=?,summary_updated_at=?,updated_at=? WHERE id=?')
      .run(summary, stamp, stamp, sessionId);
  }

  activate(sessionId: string, projectId: string) {
    const stamp = now();
    this.db.prepare('UPDATE projects SET active_session_id=?,updated_at=? WHERE id=?').run(sessionId, stamp, projectId);
    this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(stamp, sessionId);
  }

  updateTitle(sessionId: string, title: string): Session | null {
    const stamp = now();
    this.db.prepare('UPDATE sessions SET title=?,updated_at=? WHERE id=?').run(title, stamp, sessionId);
    return this.getById(sessionId);
  }

  delete(sessionId: string) {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
  }

  addMessage(input: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    const message: ChatMessage = { ...input, id: randomUUID(), createdAt: now() };
    this.db.prepare('INSERT INTO messages (id,session_id,task_id,role,agent,content,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(message.id, message.sessionId, message.taskId, message.role, message.agent, message.content, message.createdAt);
    this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(message.createdAt, message.sessionId);
    return message;
  }

  listMessages(sessionId: string): ChatMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at').all(sessionId).map(mapMessage);
  }
}
