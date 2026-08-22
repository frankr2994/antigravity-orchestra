import type { DatabaseSync } from 'node:sqlite';

// ============================================================================
// Orchestra Persistence: Versioned & Idempotent Migrations
// ============================================================================

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root TEXT NOT NULL UNIQUE,
          git_root TEXT,
          onboarding_status TEXT NOT NULL DEFAULT 'pending',
          onboarding_version TEXT,
          active_session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          antigravity_conversation_id TEXT,
          summary TEXT,
          summary_updated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          task_id TEXT,
          role TEXT NOT NULL,
          agent TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          classification TEXT,
          models TEXT,
          result TEXT,
          error TEXT,
          commit_sha TEXT,
          push_status TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS git_operations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          task_id TEXT,
          kind TEXT NOT NULL,
          sha TEXT,
          branch TEXT,
          push_status TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);
      `);
    },
  },
  {
    version: 2,
    name: 'cloud_execution_and_attempts',
    up: (db: DatabaseSync) => {
      // Add target column to tasks table if not present
      const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
      if (!taskColumns.some((col) => col.name === 'target')) {
        db.exec("ALTER TABLE tasks ADD COLUMN target TEXT DEFAULT 'local';");
      }

      // Add summary columns to sessions if legacy db was missing them
      const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      if (!sessionColumns.some((col) => col.name === 'summary')) {
        db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT;');
      }
      if (!sessionColumns.some((col) => col.name === 'summary_updated_at')) {
        db.exec('ALTER TABLE sessions ADD COLUMN summary_updated_at TEXT;');
      }

      // Create dedicated execution_attempts table
      db.exec(`
        CREATE TABLE IF NOT EXISTS execution_attempts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          target TEXT NOT NULL,
          worker TEXT NOT NULL,
          provider_session_id TEXT,
          base_sha TEXT NOT NULL,
          head_sha TEXT,
          branch_name TEXT,
          pr_url TEXT,
          state TEXT NOT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_task ON execution_attempts(task_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS cloud_sessions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL,
          source_name TEXT NOT NULL,
          session_resource_name TEXT NOT NULL,
          remote_session_id TEXT NOT NULL,
          dispatch_branch TEXT NOT NULL,
          target_branch TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          pr_head_sha TEXT,
          pr_url TEXT,
          state TEXT NOT NULL,
          last_activity_id TEXT,
          last_activity_at TEXT,
          polling_lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cloud_sessions_task ON cloud_sessions(task_id);
        CREATE INDEX IF NOT EXISTS idx_cloud_sessions_remote ON cloud_sessions(remote_session_id);
      `);
    },
  },
];

export function runMigrations(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  let currentVersion = 0;
  for (const m of MIGRATIONS) {
    if (!appliedVersions.has(m.version)) {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
    }
    currentVersion = m.version;
  }

  return currentVersion;
}
