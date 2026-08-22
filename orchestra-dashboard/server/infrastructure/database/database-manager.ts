import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations.js';
import {
  ProjectRepository,
  SessionRepository,
  TaskRepository,
  TaskEventRepository,
  ExecutionAttemptRepository,
  CloudSessionRepository,
  GitOperationRepository,
  SettingsRepository,
} from './repositories/index.js';

// ============================================================================
// Orchestra Infrastructure: DatabaseManager
// ============================================================================

export class DatabaseManager {
  readonly db: DatabaseSync;
  readonly schemaVersion: number;

  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly tasks: TaskRepository;
  readonly events: TaskEventRepository;
  readonly attempts: ExecutionAttemptRepository;
  readonly cloudSessions: CloudSessionRepository;
  readonly gitOperations: GitOperationRepository;
  readonly settings: SettingsRepository;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.schemaVersion = runMigrations(this.db);

    this.projects = new ProjectRepository(this.db);
    this.sessions = new SessionRepository(this.db);
    this.tasks = new TaskRepository(this.db);
    this.events = new TaskEventRepository(this.db);
    this.attempts = new ExecutionAttemptRepository(this.db);
    this.cloudSessions = new CloudSessionRepository(this.db);
    this.gitOperations = new GitOperationRepository(this.db);
    this.settings = new SettingsRepository(this.db);
  }

  close() {
    this.db.close();
  }
}
