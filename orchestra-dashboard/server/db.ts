import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { ChatMessage, Project, Session, TaskEvent, TaskRecord, TaskState } from './types.js';

function now() { return new Date().toISOString(); }

export class Store {
  readonly db: DatabaseSync;

  constructor(path = config.databasePath) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
        git_root TEXT, onboarding_status TEXT NOT NULL DEFAULT 'pending', onboarding_version TEXT,
        active_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL, antigravity_conversation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        task_id TEXT, role TEXT NOT NULL, agent TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, prompt TEXT NOT NULL,
        title TEXT NOT NULL, state TEXT NOT NULL, classification TEXT, models TEXT, result TEXT, error TEXT,
        commit_sha TEXT, push_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS git_operations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL,
        sha TEXT, branch TEXT, push_status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);
    `);
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === 'summary')) this.db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT;');
    if (!sessionColumns.some((column) => column.name === 'summary_updated_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN summary_updated_at TEXT;');
  }

  close() { this.db.close(); }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(mapProject);
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return row ? mapProject(row) : null;
  }

  getProjectByRoot(root: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE root=?').get(root);
    return row ? mapProject(row) : null;
  }

  upsertProject(input: { name: string; root: string; gitRoot: string | null }): Project {
    const existing = this.getProjectByRoot(input.root);
    const stamp = now();
    if (existing) {
      this.db.prepare('UPDATE projects SET name=?, git_root=?, updated_at=? WHERE id=?')
        .run(input.name, input.gitRoot, stamp, existing.id);
      return this.getProject(existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO projects
      (id,name,root,git_root,onboarding_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, input.name, input.root, input.gitRoot, 'pending', stamp, stamp);
    return this.getProject(id)!;
  }

  updateProjectOnboarding(id: string, status: string, version: string | null) {
    this.db.prepare('UPDATE projects SET onboarding_status=?, onboarding_version=?, updated_at=? WHERE id=?')
      .run(status, version, now(), id);
  }

  forgetProject(id: string) { this.db.prepare('DELETE FROM projects WHERE id=?').run(id); }

  createSession(projectId: string, title = 'New conversation'): Session {
    const id = randomUUID(); const stamp = now();
    this.db.prepare('INSERT INTO sessions (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(id, projectId, title, stamp, stamp);
    this.db.prepare('UPDATE projects SET active_session_id=?,updated_at=? WHERE id=?').run(id, stamp, projectId);
    return this.getSession(id)!;
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return row ? mapSession(row) : null;
  }

  listSessions(projectId: string): Session[] {
    return this.db.prepare('SELECT * FROM sessions WHERE project_id=? ORDER BY updated_at DESC').all(projectId).map(mapSession);
  }

  setConversationId(sessionId: string, conversationId: string) {
    this.db.prepare('UPDATE sessions SET antigravity_conversation_id=?,updated_at=? WHERE id=?')
      .run(conversationId, now(), sessionId);
  }

  setSessionSummary(sessionId: string, summary: string) {
    const stamp = now();
    this.db.prepare('UPDATE sessions SET summary=?,summary_updated_at=?,updated_at=? WHERE id=?')
      .run(summary, stamp, stamp, sessionId);
  }

  activateSession(sessionId: string, projectId: string) {
    const stamp = now();
    this.db.prepare('UPDATE projects SET active_session_id=?,updated_at=? WHERE id=?').run(sessionId, stamp, projectId);
    this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(stamp, sessionId);
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

  createTask(projectId: string, sessionId: string, prompt: string): TaskRecord {
    const id = randomUUID(); const stamp = now();
    this.db.prepare(`INSERT INTO tasks
      (id,project_id,session_id,prompt,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, projectId, sessionId, prompt, prompt.slice(0, 72), 'queued', stamp, stamp);
    return this.getTask(id)!;
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return row ? mapTask(row) : null;
  }

  listTasks(projectId?: string): TaskRecord[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').all();
    return rows.map(mapTask);
  }

  recoverInterruptedTasks() {
    const terminal = ['completed', 'completed_unpushed', 'failed', 'cancelled', 'baseline_required', 'recovery_required'];
    const placeholders = terminal.map(() => '?').join(',');
    const stamp = now();
    const rows = this.db.prepare(`SELECT id FROM tasks WHERE state NOT IN (${placeholders})`).all(...terminal) as Array<{ id: string }>;
    if (rows.length) this.db.prepare(`UPDATE tasks SET state='failed',error='The dashboard restarted while this task was running. Submit it again to retry safely.',updated_at=? WHERE state NOT IN (${placeholders})`).run(stamp, ...terminal);
    return rows.map((row) => row.id);
  }

  updateTask(id: string, fields: Partial<Pick<TaskRecord, 'state' | 'title' | 'classification' | 'models' | 'result' | 'error' | 'commitSha' | 'pushStatus'>>) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const names: Record<string, string> = { commitSha: 'commit_sha', pushStatus: 'push_status' };
    const assignments = entries.map(([key]) => `${names[key] || key}=?`).join(',');
    this.db.prepare(`UPDATE tasks SET ${assignments},updated_at=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), now(), id);
  }

  addEvent(taskId: string, agent: string, type: string, payload: unknown): TaskEvent {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO task_events (task_id,agent,type,payload,created_at) VALUES (?,?,?,?,?)')
      .run(taskId, agent, type, JSON.stringify(payload), createdAt);
    return { id: Number(result.lastInsertRowid), taskId, agent: agent as TaskEvent['agent'], type, payload, createdAt };
  }

  listEvents(taskId: string, after = 0): TaskEvent[] {
    return this.db.prepare('SELECT * FROM task_events WHERE task_id=? AND id>? ORDER BY id').all(taskId, after).map((row) => {
      const value = row as Record<string, unknown>;
      return { id: Number(value.id), taskId: String(value.task_id), agent: String(value.agent) as TaskEvent['agent'], type: String(value.type), payload: JSON.parse(String(value.payload)), createdAt: String(value.created_at) };
    });
  }

  createGitOperation(projectId: string, taskId: string | null, kind: string, sha: string | null, branch: string | null, pushStatus: string, error: string | null) {
    const id = randomUUID(); const stamp = now();
    this.db.prepare('INSERT INTO git_operations VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, taskId, kind, sha, branch, pushStatus, error, stamp, stamp);
    return id;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
}

function mapProject(row: unknown): Project { const r = row as Record<string, unknown>; return { id:String(r.id), name:String(r.name), root:String(r.root), gitRoot:r.git_root ? String(r.git_root) : null, onboardingStatus:String(r.onboarding_status), onboardingVersion:r.onboarding_version ? String(r.onboarding_version) : null, activeSessionId:r.active_session_id ? String(r.active_session_id) : null, createdAt:String(r.created_at), updatedAt:String(r.updated_at) }; }
function mapSession(row: unknown): Session { const r = row as Record<string, unknown>; return { id:String(r.id), projectId:String(r.project_id), title:String(r.title), antigravityConversationId:r.antigravity_conversation_id ? String(r.antigravity_conversation_id) : null, summary:r.summary ? String(r.summary) : null, summaryUpdatedAt:r.summary_updated_at ? String(r.summary_updated_at) : null, createdAt:String(r.created_at), updatedAt:String(r.updated_at) }; }
function mapMessage(row: unknown): ChatMessage { const r = row as Record<string, unknown>; return { id:String(r.id), sessionId:String(r.session_id), taskId:r.task_id ? String(r.task_id) : null, role:String(r.role) as ChatMessage['role'], agent:String(r.agent) as ChatMessage['agent'], content:String(r.content), createdAt:String(r.created_at) }; }
function mapTask(row: unknown): TaskRecord { const r = row as Record<string, unknown>; return { id:String(r.id), projectId:String(r.project_id), sessionId:String(r.session_id), prompt:String(r.prompt), title:String(r.title), state:String(r.state) as TaskState, classification:r.classification ? String(r.classification) : null, models:r.models ? String(r.models) : null, result:r.result ? String(r.result) : null, error:r.error ? String(r.error) : null, commitSha:r.commit_sha ? String(r.commit_sha) : null, pushStatus:r.push_status ? String(r.push_status) : null, createdAt:String(r.created_at), updatedAt:String(r.updated_at) }; }
