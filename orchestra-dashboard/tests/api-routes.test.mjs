import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createApp } from '../dist-server/bootstrap/app.js';
import { generateDynamicSessionTitle } from '../dist-server/api/routes/sessions.js';
import { Store } from '../dist-server/db.js';
import { TaskManager } from '../dist-server/tasks.js';

// ============================================================================
// Phase 5 Decomposed API Routes & Bootstrap Test Suite
// ============================================================================

test('Phase 5 API — generateDynamicSessionTitle extracts clean concise titles', () => {
  assert.equal(generateDynamicSessionTitle(''), 'New conversation');
  assert.equal(generateDynamicSessionTitle('   '), 'New conversation');
  assert.equal(generateDynamicSessionTitle('### Refactor user dashboard! And add tests.'), 'Refactor user dashboard');
  assert.equal(generateDynamicSessionTitle('Add unit tests'), 'Add unit tests');

  const longPrompt = 'Fix the crash in the SQLite migration handler when upgrading legacy databases.';
  const title = generateDynamicSessionTitle(longPrompt);
  assert.ok(title.endsWith('…'));
  assert.ok(title.length <= 50);
});

test('Phase 5 API — createApp mounts modular routers and handles requests', async () => {
  const dbPath = join(tmpdir(), `orchestra-app-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  try {
    const store = new Store(dbPath);
    const tasks = new TaskManager(store, 2);
    const app = createApp(store, tasks);

    assert.ok(app, 'Express application must be successfully constructed');

    // Verify project creation & retrieval through database store
    const proj = store.upsertProject({ name: 'Test App', root: '/tmp/test-app', gitRoot: null });
    const sess = store.createSession(proj.id, 'Test Conversation');
    assert.ok(proj.id);
    assert.ok(sess.id);

    const projectList = store.listProjects();
    assert.equal(projectList.length, 1);
    assert.equal(projectList[0].name, 'Test App');

    store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});
