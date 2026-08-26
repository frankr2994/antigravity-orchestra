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
  {
    version: 3,
    name: 'durable_workflow_coordination',
    up: (db: DatabaseSync) => {
      const cloudColumns = db.prepare('PRAGMA table_info(cloud_sessions)').all() as Array<{ name: string }>;
      if (!cloudColumns.some((column) => column.name === 'attempt_id')) {
        db.exec('ALTER TABLE cloud_sessions ADD COLUMN attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL;');
      }
      const duplicateRemote = db.prepare(`
        SELECT provider_id, remote_session_id, COUNT(*) AS count
        FROM cloud_sessions
        GROUP BY provider_id, remote_session_id
        HAVING COUNT(*) > 1
        LIMIT 1
      `).get() as { count?: number } | undefined;
      if (duplicateRemote?.count) {
        throw new Error('Cannot enforce cloud session identity: duplicate provider session rows exist');
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_sessions_provider_remote
          ON cloud_sessions(provider_id, remote_session_id);
        CREATE INDEX IF NOT EXISTS idx_cloud_sessions_attempt ON cloud_sessions(attempt_id);

        CREATE TABLE command_intents (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','acknowledged','ambiguous','failed')),
          provider_resource TEXT,
          response_json TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_command_intents_task ON command_intents(task_id, created_at);

        CREATE TABLE workflow_checkpoints (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE CASCADE,
          stage TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          subject_sha TEXT,
          data_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(task_id, stage, revision)
        );
        CREATE INDEX idx_workflow_checkpoints_latest ON workflow_checkpoints(task_id, stage, revision DESC);

        CREATE TABLE activity_cursors (
          cloud_session_id TEXT PRIMARY KEY REFERENCES cloud_sessions(id) ON DELETE CASCADE,
          next_page_token TEXT,
          last_activity_id TEXT,
          last_activity_at TEXT,
          next_poll_at TEXT NOT NULL,
          consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
          last_error_code TEXT,
          version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_activity_cursors_due ON activity_cursors(next_poll_at);

        CREATE TABLE resource_leases (
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
          expires_at TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          PRIMARY KEY(resource_type, resource_id)
        );
        CREATE INDEX idx_resource_leases_expiry ON resource_leases(expires_at);

        CREATE TABLE managed_git_resources (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE CASCADE,
          repository_root TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('dispatch_ref','review_ref','worktree','integration_ref')),
          resource_value TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('active','cleanup_pending','cleaned','cleanup_failed')),
          cleanup_after TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repository_root, kind, resource_value)
        );
        CREATE INDEX idx_managed_git_cleanup ON managed_git_resources(state, cleanup_after);

        CREATE TABLE workflow_evidence (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('routing','preflight','provider_output','review','verification','repair','integration','cleanup')),
          subject_sha TEXT,
          outcome TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_workflow_evidence_task ON workflow_evidence(task_id, kind, created_at);
        CREATE UNIQUE INDEX uq_workflow_evidence_sha
          ON workflow_evidence(attempt_id, kind, subject_sha)
          WHERE attempt_id IS NOT NULL AND subject_sha IS NOT NULL;

        CREATE TABLE workflow_outbox (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          topic TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','publishing','published','failed')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          available_at TEXT NOT NULL,
          published_at TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_workflow_outbox_due ON workflow_outbox(state, available_at);
      `);
    },
  },
  {
    version: 4,
    name: 'verified_jules_source_mappings',
    up: (db) => {
      db.exec(`
        CREATE TABLE jules_source_mappings (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          source_name TEXT NOT NULL,
          github_owner TEXT NOT NULL,
          github_repo TEXT NOT NULL,
          starting_branch TEXT NOT NULL,
          source_fingerprint TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_jules_source_identity
          ON jules_source_mappings(github_owner, github_repo);
      `);
    },
  },
  {
    version: 5,
    name: 'durable_jules_activity_receipts',
    up: (db) => {
      db.exec(`
        CREATE TABLE jules_activity_receipts (
          cloud_session_id TEXT NOT NULL REFERENCES cloud_sessions(id) ON DELETE CASCADE,
          activity_id TEXT NOT NULL,
          create_time TEXT,
          received_at TEXT NOT NULL,
          PRIMARY KEY(cloud_session_id, activity_id)
        );
        CREATE INDEX idx_jules_activity_receipts_time
          ON jules_activity_receipts(cloud_session_id, create_time);
      `);
    },
  },
  {
    version: 6,
    name: 'parallel_cloud_workflows',
    up: (db) => {
      db.exec(`
        CREATE TABLE cloud_workflow_batches (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('running','completed','failed','blocked')),
          max_concurrency INTEGER NOT NULL CHECK(max_concurrency BETWEEN 1 AND 32),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE cloud_workflow_nodes (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL REFERENCES cloud_workflow_batches(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          prompt TEXT NOT NULL,
          dependencies_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','dispatching','running','completed','failed','blocked')),
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(batch_id, ordinal),
          UNIQUE(task_id)
        );
        CREATE INDEX idx_cloud_workflow_nodes_ready ON cloud_workflow_nodes(batch_id,state,ordinal);
      `);
    },
  },
  {
    version: 7,
    name: 'jules_capacity_reservations',
    up: (db) => {
      db.exec(`
        CREATE TABLE jules_capacity_reservations (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN ('active','released')),
          acquired_at TEXT NOT NULL,
          released_at TEXT
        );
        CREATE INDEX idx_jules_capacity_active ON jules_capacity_reservations(state, acquired_at);
      `);
    },
  },
  {
    version: 8,
    name: 'jules_source_target_branch',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(jules_source_mappings)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'target_branch')) {
        db.exec('ALTER TABLE jules_source_mappings ADD COLUMN target_branch TEXT;');
        db.exec('UPDATE jules_source_mappings SET target_branch=starting_branch WHERE target_branch IS NULL;');
      }
    },
  },
  {
    version: 9,
    name: 'repair_cloud_session_attempt_link',
    up: (db) => {
      // Some installations applied the original v3 migration before attempt_id
      // was added to that migration definition. A forward repair is required;
      // editing an already-applied migration cannot upgrade those databases.
      const columns = db.prepare('PRAGMA table_info(cloud_sessions)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'attempt_id')) {
        db.exec('ALTER TABLE cloud_sessions ADD COLUMN attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL;');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_sessions_attempt ON cloud_sessions(attempt_id);');
    },
  },
  {
    version: 10,
    name: 'provider_run_accounting',
    up: (db) => {
      db.exec(`
        CREATE TABLE provider_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK(provider IN ('gemma','jules','antigravity','codex')),
          operation TEXT NOT NULL,
          model TEXT,
          primary_worker INTEGER NOT NULL CHECK(primary_worker IN (0,1)),
          prompt_fingerprint TEXT,
          estimated_input_tokens INTEGER CHECK(estimated_input_tokens IS NULL OR estimated_input_tokens >= 0),
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
          input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
          cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
          output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
          reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),
          total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX idx_provider_runs_provider_time ON provider_runs(provider, started_at DESC);
        CREATE INDEX idx_provider_runs_task_time ON provider_runs(task_id, started_at DESC);
      `);
    },
  },
];

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number; name: string }>;
  const knownByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const latestKnown = migrations.at(-1)?.version ?? 0;
  for (const applied of appliedRows) {
    const known = knownByVersion.get(applied.version);
    if (!known) throw new Error(`Database schema version ${applied.version} is newer than supported version ${latestKnown}`);
    if (known.name !== applied.name) throw new Error(`Migration identity mismatch at version ${applied.version}`);
  }
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  let currentVersion = 0;
  for (const m of migrations) {
    if (!appliedVersions.has(m.version)) {
      db.exec('BEGIN IMMEDIATE');
      try {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    currentVersion = m.version;
  }

  return currentVersion;
}
