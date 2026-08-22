import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import type { ChatMessage, Project, Session, TaskEvent, TaskRecord, ExecutionTarget } from './types.js';
import { DatabaseManager } from './infrastructure/database/index.js';

// ============================================================================
// Orchestra Store (Compatibility Facade backed by DatabaseManager)
// ============================================================================

export class Store {
  readonly manager: DatabaseManager;

  constructor(path = config.databasePath) {
    this.manager = new DatabaseManager(path);
  }

  get db(): DatabaseSync {
    return this.manager.db;
  }

  close() {
    this.manager.close();
  }

  // Project operations
  listProjects(): Project[] {
    return this.manager.projects.list();
  }

  getProject(id: string): Project | null {
    return this.manager.projects.getById(id);
  }

  getProjectByRoot(root: string): Project | null {
    return this.manager.projects.getByRoot(root);
  }

  upsertProject(input: { name: string; root: string; gitRoot: string | null }): Project {
    return this.manager.projects.upsert(input);
  }

  updateProjectOnboarding(id: string, status: string, version: string | null) {
    this.manager.projects.updateOnboarding(id, status, version);
  }

  forgetProject(id: string) {
    this.manager.projects.delete(id);
  }

  // Session operations
  createSession(projectId: string, title = 'New conversation'): Session {
    return this.manager.sessions.create(projectId, title);
  }

  getSession(id: string): Session | null {
    return this.manager.sessions.getById(id);
  }

  listSessions(projectId: string): Session[] {
    return this.manager.sessions.listByProject(projectId);
  }

  setConversationId(sessionId: string, conversationId: string) {
    this.manager.sessions.setConversationId(sessionId, conversationId);
  }

  setSessionSummary(sessionId: string, summary: string) {
    this.manager.sessions.setSummary(sessionId, summary);
  }

  activateSession(sessionId: string, projectId: string) {
    this.manager.sessions.activate(sessionId, projectId);
  }

  updateSessionTitle(sessionId: string, title: string): Session | null {
    return this.manager.sessions.updateTitle(sessionId, title);
  }

  deleteSession(sessionId: string) {
    this.manager.sessions.delete(sessionId);
  }

  // Message operations
  addMessage(input: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    return this.manager.sessions.addMessage(input);
  }

  listMessages(sessionId: string): ChatMessage[] {
    return this.manager.sessions.listMessages(sessionId);
  }

  // Task operations
  createTask(
    projectId: string,
    sessionId: string,
    prompt: string,
    classification: string | null = null,
    models: string | null = null,
    target: ExecutionTarget = 'local'
  ): TaskRecord {
    return this.manager.tasks.create(projectId, sessionId, prompt, classification, models, target);
  }

  getTask(id: string): TaskRecord | null {
    return this.manager.tasks.getById(id);
  }

  listTasks(projectId?: string): TaskRecord[] {
    return this.manager.tasks.list(projectId);
  }

  recoverInterruptedTasks(): string[] {
    return this.manager.tasks.recoverInterruptedTasks();
  }

  updateTask(
    id: string,
    fields: Partial<Pick<TaskRecord, 'state' | 'title' | 'target' | 'classification' | 'models' | 'result' | 'error' | 'commitSha' | 'pushStatus'>>
  ) {
    this.manager.tasks.update(id, fields);
  }

  // Event operations
  addEvent(taskId: string, agent: string, type: string, payload: unknown): TaskEvent {
    return this.manager.events.add(taskId, agent, type, payload);
  }

  listEvents(taskId: string, after = 0): TaskEvent[] {
    return this.manager.events.list(taskId, after);
  }

  // Git operations
  createGitOperation(
    projectId: string,
    taskId: string | null,
    kind: string,
    sha: string | null,
    branch: string | null,
    pushStatus: string,
    error: string | null
  ): string {
    return this.manager.gitOperations.create(projectId, taskId, kind, sha, branch, pushStatus, error);
  }

  // Settings operations
  getSetting(key: string): string | null {
    return this.manager.settings.get(key);
  }

  setSetting(key: string, value: string) {
    this.manager.settings.set(key, value);
  }
}
