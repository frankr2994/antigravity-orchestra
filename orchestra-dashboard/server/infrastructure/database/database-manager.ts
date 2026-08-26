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
  CommandIntentRepository,
  WorkflowCheckpointRepository,
  ActivityCursorRepository,
  ResourceLeaseRepository,
  ManagedGitResourceRepository,
  WorkflowEvidenceRepository,
  WorkflowOutboxRepository,
  JulesSourceMappingRepository,
  JulesActivityReceiptRepository,
  CloudWorkflowRepository,
  JulesCapacityRepository,
  ProviderRunRepository,
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
  readonly commandIntents: CommandIntentRepository;
  readonly checkpoints: WorkflowCheckpointRepository;
  readonly activityCursors: ActivityCursorRepository;
  readonly leases: ResourceLeaseRepository;
  readonly managedGitResources: ManagedGitResourceRepository;
  readonly evidence: WorkflowEvidenceRepository;
  readonly outbox: WorkflowOutboxRepository;
  readonly julesSourceMappings: JulesSourceMappingRepository;
  readonly julesActivityReceipts: JulesActivityReceiptRepository;
  readonly cloudWorkflows: CloudWorkflowRepository;
  readonly julesCapacity: JulesCapacityRepository;
  readonly providerRuns: ProviderRunRepository;

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
    this.commandIntents = new CommandIntentRepository(this.db);
    this.checkpoints = new WorkflowCheckpointRepository(this.db);
    this.activityCursors = new ActivityCursorRepository(this.db);
    this.leases = new ResourceLeaseRepository(this.db);
    this.managedGitResources = new ManagedGitResourceRepository(this.db);
    this.evidence = new WorkflowEvidenceRepository(this.db);
    this.outbox = new WorkflowOutboxRepository(this.db);
    this.julesSourceMappings = new JulesSourceMappingRepository(this.db);
    this.julesActivityReceipts = new JulesActivityReceiptRepository(this.db);
    this.cloudWorkflows = new CloudWorkflowRepository(this.db);
    this.julesCapacity = new JulesCapacityRepository(this.db);
    this.providerRuns = new ProviderRunRepository(this.db);
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
