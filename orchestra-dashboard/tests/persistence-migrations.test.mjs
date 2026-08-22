import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager, runMigrations } from '../dist-server/infrastructure/database/index.js';
import { Store } from '../dist-server/db.js';

// ============================================================================
// Phase 4 Modular Persistence & Migrations Test Suite
// ============================================================================

test('Phase 4 Persistence — Versioned Migrations run on fresh database', () => {
  const dbPath = join(tmpdir(), `orchestra-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const db = new DatabaseSync(dbPath);
    const version = runMigrations(db);
    assert.ok(version >= 2, 'Migration engine must apply all migrations up to at least v2');

    const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version ASC').all();
    assert.equal(applied.length, 2);
    assert.equal(applied[0].version, 1);
    assert.equal(applied[1].version, 2);

    // Re-running migrations is idempotent
    const rerunVersion = runMigrations(db);
    assert.equal(rerunVersion, 2);

    db.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 4 Persistence — Legacy unversioned database migrates to v2 without losing data', () => {
  const dbPath = join(tmpdir(), `orchestra-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    // 1. Create a legacy pre-v2 database without schema_migrations table
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, git_root TEXT, onboarding_status TEXT, onboarding_version TEXT, active_session_id TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, antigravity_conversation_id TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, prompt TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, classification TEXT, models TEXT, result TEXT, error TEXT, commit_sha TEXT, push_status TEXT, created_at TEXT, updated_at TEXT);
    `);
    legacyDb.prepare("INSERT INTO projects VALUES ('p1', 'Legacy App', '/tmp/legacy', NULL, 'complete', '1.0', NULL, '2026-01-01', '2026-01-01')").run();
    legacyDb.prepare("INSERT INTO sessions VALUES ('s1', 'p1', 'Old Session', NULL, '2026-01-01', '2026-01-01')").run();
    legacyDb.prepare("INSERT INTO tasks VALUES ('t1', 'p1', 's1', 'Build thing', 'Build thing', 'completed', NULL, NULL, 'Done', NULL, 'sha1', 'pushed', '2026-01-01', '2026-01-01')").run();
    legacyDb.close();

    // 2. Open via DatabaseManager and verify automatic migration & data preservation
    const manager = new DatabaseManager(dbPath);
    assert.ok(manager.schemaVersion >= 2);

    const project = manager.projects.getById('p1');
    assert.equal(project?.name, 'Legacy App');

    const session = manager.sessions.getById('s1');
    assert.equal(session?.title, 'Old Session');

    const task = manager.tasks.getById('t1');
    assert.equal(task?.prompt, 'Build thing');
    assert.equal(task?.target, 'local'); // Defaulted in v2 migration

    manager.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 4 Persistence — Modular Repositories CRUD (CloudSessions, Attempts, Projects, Tasks)', () => {
  const dbPath = join(tmpdir(), `orchestra-repos-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const manager = new DatabaseManager(dbPath);

    // 1. Projects & Sessions
    const proj = manager.projects.upsert({ name: 'Cloud App', root: '/tmp/cloud-app', gitRoot: '/tmp/cloud-app' });
    const sess = manager.sessions.create(proj.id, 'Cloud Session 1');
    assert.ok(proj.id);
    assert.ok(sess.id);

    // 2. Tasks with cloud execution target
    const task = manager.tasks.create(proj.id, sess.id, 'Cloud Refactoring', null, null, 'cloud');
    assert.equal(task.target, 'cloud');
    assert.equal(task.state, 'queued');

    // 3. Execution Attempts Repository
    const attempt = manager.attempts.create({
      taskId: task.id,
      target: 'cloud',
      worker: 'jules',
      baseSha: 'deadbeef1234',
      branchName: 'orchestra/jules-base/1234',
      state: 'WORKING',
    });
    assert.equal(attempt.worker, 'jules');
    assert.equal(attempt.baseSha, 'deadbeef1234');

    manager.attempts.update(attempt.id, {
      headSha: 'cafebabe5678',
      prUrl: 'https://github.com/example/repo/pull/42',
      state: 'COMPLETED',
    });
    const updatedAttempt = manager.attempts.getById(attempt.id);
    assert.equal(updatedAttempt?.headSha, 'cafebabe5678');
    assert.equal(updatedAttempt?.prUrl, 'https://github.com/example/repo/pull/42');
    assert.equal(updatedAttempt?.state, 'COMPLETED');

    // 4. Cloud Sessions Repository
    const cloudSession = manager.cloudSessions.create({
      taskId: task.id,
      sourceName: 'sources/github/example/repo',
      sessionResourceName: 'sessions/jules-session-999',
      remoteSessionId: 'jules-session-999',
      dispatchBranch: 'orchestra/jules-base/1234',
      targetBranch: 'main',
      baseSha: 'deadbeef1234',
      state: 'IN_PROGRESS',
    });
    assert.equal(cloudSession.remoteSessionId, 'jules-session-999');

    const nonTerminal = manager.cloudSessions.listNonTerminal();
    assert.equal(nonTerminal.length, 1);
    assert.equal(nonTerminal[0].remoteSessionId, 'jules-session-999');

    manager.cloudSessions.update(cloudSession.id, {
      state: 'COMPLETED',
      prUrl: 'https://github.com/example/repo/pull/42',
      prHeadSha: 'cafebabe5678',
    });
    const updatedCloudSession = manager.cloudSessions.getById(cloudSession.id);
    assert.equal(updatedCloudSession?.state, 'COMPLETED');

    const nonTerminalAfter = manager.cloudSessions.listNonTerminal();
    assert.equal(nonTerminalAfter.length, 0);

    // 5. Settings Repository
    manager.settings.set('theme', 'dark');
    assert.equal(manager.settings.get('theme'), 'dark');

    manager.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 4 Persistence — Store facade retains 100% backwards-compatibility', () => {
  const dbPath = join(tmpdir(), `orchestra-facade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const store = new Store(dbPath);

    const project = store.upsertProject({ name: 'Facade App', root: '/tmp/facade', gitRoot: null });
    const session = store.createSession(project.id, 'Session 1');
    const task = store.createTask(project.id, session.id, 'Run test');
    store.addEvent(task.id, 'system', 'task.state', { state: 'running' });

    const events = store.listEvents(task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].agent, 'system');

    store.updateTask(task.id, { state: 'completed', result: 'Success' });
    const loaded = store.getTask(task.id);
    assert.equal(loaded?.state, 'completed');
    assert.equal(loaded?.result, 'Success');

    store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});
