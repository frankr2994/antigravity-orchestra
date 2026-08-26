import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { errorHandlerMiddleware } from '../dist-server/api/middleware/error.js';
import { createSessionsRouter } from '../dist-server/api/routes/sessions.js';
import { createTasksRouter } from '../dist-server/api/routes/tasks.js';
import { Store } from '../dist-server/db.js';
import { TaskManager } from '../dist-server/tasks.js';

const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

function git(cwd, args) {
  const result = spawnSync('git.exe', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initializeRepository(projectRoot) {
  mkdirSync(projectRoot, { recursive: true });
  git(projectRoot, ['init', '-b', 'main']);
  git(projectRoot, ['config', 'user.name', 'Tester']);
  git(projectRoot, ['config', 'user.email', 'tester@example.com']);
  writeFileSync(join(projectRoot, 'app.ts'), 'export const value = 1;\n');
  git(projectRoot, ['add', 'app.ts']);
  git(projectRoot, ['commit', '-m', 'baseline']);
}

function createRecoveryTask(store, project, session) {
  const task = store.createTask(project.id, session.id, 'Repair the existing implementation');
  store.updateTask(task.id, { state: 'running' });
  store.updateTask(task.id, { state: 'recovering' });
  store.updateTask(task.id, { state: 'recovery_required' });
  return store.getTask(task.id);
}

async function startApi(store, manager) {
  const app = express();
  app.use(express.json());
  app.use('/api', createSessionsRouter(store, manager));
  app.use('/api', createTasksRouter(store, manager));
  app.use(errorHandlerMiddleware);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

function createFixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const projectRoot = join(root, 'project');
  initializeRepository(projectRoot);
  const store = new Store(join(root, 'orchestra.db'));
  const project = store.upsertProject({ name: 'Ownership fixture', root: projectRoot, gitRoot: projectRoot });
  const ownerSession = store.createSession(project.id, 'Existing work');
  const ownerTask = createRecoveryTask(store, project, ownerSession);
  const newSession = store.createSession(project.id, 'New conversation');
  const manager = new TaskManager(store, 1);
  manager.enqueue = () => undefined;
  return { root, projectRoot, store, project, ownerSession, ownerTask, newSession, manager };
}

test('Task ownership — a clean non-running recovery task releases ownership and a new conversation starts', async () => {
  const fixture = createFixture('orchestra-owner-clean-');
  const attempt = fixture.store.manager.attempts.create({
    taskId: fixture.ownerTask.id,
    target: 'local',
    worker: 'antigravity',
    baseSha: git(fixture.projectRoot, ['rev-parse', 'HEAD']),
    state: 'WORKING',
  });
  let server;
  try {
    server = await startApi(fixture.store, fixture.manager);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${fixture.newSession.id}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Implement the next feature', mode: 'orchestra' }),
    });
    const created = await response.json();

    assert.equal(response.status, 202);
    assert.equal(created.sessionId, fixture.newSession.id);
    assert.equal(fixture.store.getTask(fixture.ownerTask.id).state, 'cancelled');
    assert.equal(fixture.store.manager.attempts.getById(attempt.id).state, 'CANCELLED');
    assert.equal(fixture.store.getSession(fixture.newSession.id).title, 'Implement the next feature');
    assert.ok(fixture.store.listEvents(fixture.ownerTask.id).some((event) => event.type === 'task.state' && event.payload.ownershipReleased === true));

    const owner = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${fixture.project.id}/active-task`);
    assert.equal((await owner.json()).id, created.id, 'the newly submitted task becomes the only project owner');
  } finally {
    if (server) await closeServer(server);
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Task ownership — preserved project changes retain ownership and return an actionable conflict', async () => {
  const fixture = createFixture('orchestra-owner-dirty-');
  writeFileSync(join(fixture.projectRoot, 'app.ts'), 'export const value = 2;\n');
  let server;
  try {
    server = await startApi(fixture.store, fixture.manager);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${fixture.newSession.id}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Start unrelated work', mode: 'orchestra' }),
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.code, 'PROJECT_TASK_ACTIVE');
    assert.match(body.error, /Existing work|Repair the existing implementation/i);
    assert.match(body.nextAction, /Open its conversation/i);
    assert.equal(fixture.store.getTask(fixture.ownerTask.id).state, 'recovery_required');
    assert.equal(fixture.store.getSession(fixture.newSession.id).title, 'New conversation', 'a rejected prompt must not rename the blank conversation');
    assert.equal(fixture.store.listTasks(fixture.project.id).length, 1, 'the conflict must not create a duplicate task');

    const reconcile = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${fixture.project.id}/task-ownership/reconcile`, { method: 'POST' });
    assert.equal((await reconcile.json()).id, fixture.ownerTask.id, 'dirty recovery ownership is never auto-released');
  } finally {
    if (server) await closeServer(server);
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Task ownership — concurrent prompts cannot both claim a project after stale-owner reconciliation', async () => {
  const fixture = createFixture('orchestra-owner-race-');
  const competingSession = fixture.store.createSession(fixture.project.id, 'New conversation');
  let server;
  try {
    server = await startApi(fixture.store, fixture.manager);
    const submit = (sessionId, prompt) => fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${sessionId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode: 'orchestra' }),
    });
    const responses = await Promise.all([
      submit(fixture.newSession.id, 'First concurrent task'),
      submit(competingSession.id, 'Second concurrent task'),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const statuses = responses.map((response) => response.status).sort();

    assert.deepEqual(statuses, [202, 409]);
    assert.equal(bodies.filter((body) => body.code === 'PROJECT_TASK_ACTIVE').length, 1);
    assert.equal(fixture.store.listTasks(fixture.project.id).length, 2, 'only the cancelled stale task and one new owner may exist');
    assert.equal(fixture.store.listTasks(fixture.project.id).filter((task) => task.state === 'queued').length, 1);
    assert.equal(fixture.store.listSessions(fixture.project.id).filter((item) => item.title === 'New conversation').length, 1, 'the losing conversation remains blank');
  } finally {
    if (server) await closeServer(server);
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Conversation UI — new conversations restore only their own task while exposing the project owner', () => {
  const source = readFileSync(new URL('../src/features/dashboard/DashboardWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(source, /restoreProjectTask\(project\.id, created\.id, true\)/);
  assert.match(source, /filter\(\(task\) => task\.sessionId === selectedSessionId\)/);
  assert.match(source, />Open active task</);
  assert.doesNotMatch(source, /await restoreProjectTask\(project\.id\);/);
});
