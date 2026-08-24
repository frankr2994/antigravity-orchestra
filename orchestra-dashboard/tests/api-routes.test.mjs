import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createApp } from '../dist-server/bootstrap/app.js';
import { createApiRouter } from '../dist-server/api/routes/index.js';
import { config, hasJulesCapability, parseJulesRolloutStage, parseStrictBoolean } from '../dist-server/config.js';
import express from 'express';
import { generateDynamicSessionTitle } from '../dist-server/api/routes/sessions.js';
import { Store } from '../dist-server/db.js';
import { TaskManager } from '../dist-server/tasks.js';
import { ApplicationError } from '../dist-server/application/errors.js';
import { errorHandlerMiddleware } from '../dist-server/api/middleware/error.js';
import { createTasksRouter } from '../dist-server/api/routes/tasks.js';

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

test('Stage 0 — Jules configuration is strict and capability ordered', () => {
  assert.equal(parseStrictBoolean(undefined), false);
  assert.equal(parseStrictBoolean('false'), false);
  assert.equal(parseStrictBoolean('1'), false);
  assert.equal(parseStrictBoolean('TRUE'), true);
  assert.equal(parseJulesRolloutStage('nonsense'), 'connect');
  assert.equal(parseJulesRolloutStage(' REVIEW '), 'review');
  assert.equal(hasJulesCapability('review', 'read'), true);
  assert.equal(hasJulesCapability('read', 'dispatch'), false);
});

test('baseline API preserves typed Gemma failures and rejects cross-project task identities', async () => {
  const dbPath = join(tmpdir(), `orchestra-baseline-route-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let server;
  let store;
  try {
    store = new Store(dbPath);
    const first = store.upsertProject({ name: 'First', root: join(tmpdir(), 'baseline-first'), gitRoot: null });
    const second = store.upsertProject({ name: 'Second', root: join(tmpdir(), 'baseline-second'), gitRoot: null });
    const firstSession = store.createSession(first.id, 'First');
    const secondSession = store.createSession(second.id, 'Second');
    const firstTask = store.createTask(first.id, firstSession.id, 'Implement first');
    const secondTask = store.createTask(second.id, secondSession.id, 'Implement second');
    for (const task of [firstTask, secondTask]) {
      store.updateTask(task.id, { state: 'preflight' });
      store.updateTask(task.id, { state: 'baseline_required' });
    }
    let calls = 0;
    const tasks = {
      resolveBaseline: async () => {
        calls += 1;
        throw new ApplicationError('BASELINE_REVIEW_UNAVAILABLE', 'Gemma could not finish reviewing the existing changes. Nothing was committed; check the task activity and retry.', 503);
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createTasksRouter(store, tasks));
    app.use(errorHandlerMiddleware);
    server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const headers = { 'Content-Type': 'application/json' };

    const mismatch = await fetch(`${baseUrl}/projects/${first.id}/baseline`, {
      method: 'POST', headers, body: JSON.stringify({ taskId: secondTask.id }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).code, 'TASK_PROJECT_MISMATCH');
    assert.equal(calls, 0);

    const unavailable = await fetch(`${baseUrl}/projects/${first.id}/baseline`, {
      method: 'POST', headers, body: JSON.stringify({ taskId: firstTask.id }),
    });
    const body = await unavailable.json();
    assert.equal(unavailable.status, 503);
    assert.equal(body.code, 'BASELINE_REVIEW_UNAVAILABLE');
    assert.match(body.error, /Nothing was committed/);
    assert.equal(calls, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (store) store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Stage 0 — Jules can be enabled and disabled through persisted application settings', async () => {
  const dbPath = join(tmpdir(), `orchestra-app-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let server;
  let store;
  try {
    store = new Store(dbPath);
    store.manager.settings.set('jules.enabled', 'false');
    const tasks = new TaskManager(store, 2);
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(store, tasks));
    server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const headers = { 'X-Orchestra-Token': config.uiToken, 'Content-Type': 'application/json' };
    const credential = await fetch(`${baseUrl}/jules/credential-status`, { headers });
    assert.equal(credential.status, 200, 'credential setup stays available while Jules is disabled');
    const disabled = await fetch(`${baseUrl}/jules/settings`, { headers });
    assert.equal((await disabled.json()).enabled, false);
    assert.equal((await fetch(`${baseUrl}/jules/operations`, { headers })).status, 501);

    const missingPlan = await fetch(`${baseUrl}/jules/settings`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(missingPlan.status, 400, 'first-time enablement requires an explicit quota plan');
    const enabled = await fetch(`${baseUrl}/jules/settings`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: true, quotaPlan: 'free', rolling24HourLimit: 15 }) });
    assert.deepEqual(await enabled.json(), { enabled: true, rolloutStage: 'auto', quotaPlan: 'free', rolling24HourLimit: 15 });
    assert.equal((await fetch(`${baseUrl}/jules/operations`, { headers })).status, 200, 'runtime routes observe the toggle without restart');

    const off = await fetch(`${baseUrl}/jules/settings`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await off.json(), { enabled: false, rolloutStage: 'off', quotaPlan: 'free', rolling24HourLimit: 15 });
    assert.equal((await fetch(`${baseUrl}/jules/operations`, { headers })).status, 501);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (store) store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});
