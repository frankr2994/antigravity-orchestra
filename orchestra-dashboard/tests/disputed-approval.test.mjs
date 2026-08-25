import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist-server/db.js';
import { TaskManager } from '../dist-server/tasks.js';
import { GitFinalizationService, simpleChangeSummary } from '../dist-server/application/git/git-finalization-service.js';
import { createTasksRouter } from '../dist-server/api/routes/tasks.js';
import { errorHandlerMiddleware } from '../dist-server/api/middleware/error.js';

const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

function git(cwd, args) {
  const result = spawnSync('git.exe', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initializeRepository(projectRoot, remoteRoot = null) {
  mkdirSync(projectRoot, { recursive: true });
  git(projectRoot, ['init', '-b', 'main']);
  git(projectRoot, ['config', 'user.name', 'Tester']);
  git(projectRoot, ['config', 'user.email', 'tester@example.com']);
  writeFileSync(join(projectRoot, 'app.ts'), 'export const value = 1;\n');
  git(projectRoot, ['add', 'app.ts']);
  git(projectRoot, ['commit', '-m', 'baseline']);
  if (remoteRoot) {
    mkdirSync(remoteRoot, { recursive: true });
    git(remoteRoot, ['init', '--bare', '--initial-branch=main']);
    git(projectRoot, ['remote', 'add', 'origin', remoteRoot]);
    git(projectRoot, ['push', '-u', 'origin', 'main']);
  }
}

function createCommitReadyTask(store, root, state = 'paused') {
  const project = store.upsertProject({ name: 'Manual commit fixture', root, gitRoot: root });
  const session = store.createSession(project.id, 'Manual commit fixture');
  const task = store.createTask(project.id, session.id, 'Implement the requested change');
  store.updateTask(task.id, { state: 'running' });
  if (state === 'paused') store.updateTask(task.id, { state: 'paused' });
  else if (state === 'recovery_required') {
    store.updateTask(task.id, { state: 'recovering' });
    store.updateTask(task.id, { state: 'recovery_required' });
  } else store.updateTask(task.id, { state });
  return { project, session, task: store.getTask(task.id) };
}

async function startApi(store, manager) {
  const app = express();
  app.use(express.json());
  app.use('/api', createTasksRouter(store, manager));
  app.use(errorHandlerMiddleware);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

test('Commit & Push Changes creates one deterministic commit, pushes it, and is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-manual-commit-'));
  const projectRoot = join(root, 'project');
  const remoteRoot = join(root, 'remote.git');
  const store = new Store(join(root, 'orchestra.db'));
  let server;
  try {
    initializeRepository(projectRoot, remoteRoot);
    writeFileSync(join(projectRoot, 'app.ts'), 'export const value = 2;\n');
    writeFileSync(join(projectRoot, 'new-file.ts'), 'export const added = true;\n');
    const fixture = createCommitReadyTask(store, projectRoot, 'recovery_required');
    const manager = new TaskManager(store, 1);
    server = await startApi(store, manager);
    const endpoint = `http://127.0.0.1:${server.address().port}/api/tasks/${fixture.task.id}/commit-changes`;

    const response = await fetch(endpoint, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.state, 'completed');
    assert.equal(body.pushStatus, 'pushed');
    assert.match(body.result, /Committed [0-9a-f]{8} and pushed/);
    assert.equal(git(projectRoot, ['status', '--porcelain']), '');
    assert.equal(git(projectRoot, ['log', '--format=%s', '-1']), 'chore: commit uncommitted changes');
    assert.equal(git(projectRoot, ['rev-list', '--count', 'HEAD']), '2');
    assert.equal(git(projectRoot, ['rev-parse', 'HEAD']), git(remoteRoot, ['rev-parse', 'main']));

    const repeated = await fetch(endpoint, { method: 'POST' });
    assert.equal(repeated.status, 202);
    assert.equal((await repeated.json()).state, 'completed');
    assert.equal(git(projectRoot, ['rev-list', '--count', 'HEAD']), '2');
  } finally {
    if (server) await closeServer(server);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Commit & Push Changes reports a typed error for a missing Git repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-manual-no-git-'));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  const store = new Store(join(root, 'orchestra.db'));
  let server;
  try {
    const fixture = createCommitReadyTask(store, projectRoot);
    const manager = new TaskManager(store, 1);
    manager.gitFinalization = {
      finalize: async () => ({ status: 'skipped', reason: 'not_git', head: null, branch: null }),
    };
    server = await startApi(store, manager);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${fixture.task.id}/commit-changes`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, 'PROJECT_NOT_GIT');
    assert.notEqual(body.code, 'INTERNAL_ERROR');
    assert.match(body.nextAction, /Initialize or restore Git/);
    assert.equal(store.getTask(fixture.task.id).state, 'paused');
  } finally {
    if (server) await closeServer(server);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Commit & Push Changes refuses an empty commit with a typed response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-manual-empty-'));
  const projectRoot = join(root, 'project');
  const store = new Store(join(root, 'orchestra.db'));
  let server;
  try {
    initializeRepository(projectRoot);
    const fixture = createCommitReadyTask(store, projectRoot);
    const manager = new TaskManager(store, 1);
    server = await startApi(store, manager);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${fixture.task.id}/commit-changes`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, 'NO_UNCOMMITTED_CHANGES');
    assert.notEqual(body.code, 'INTERNAL_ERROR');
    assert.equal(git(projectRoot, ['rev-list', '--count', 'HEAD']), '1');
    assert.equal(store.getTask(fixture.task.id).state, 'paused');
  } finally {
    if (server) await closeServer(server);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Commit & Push Changes converts Git failures into an actionable error and restores the task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-manual-failure-'));
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  const store = new Store(join(root, 'orchestra.db'));
  let server;
  try {
    const fixture = createCommitReadyTask(store, projectRoot);
    const manager = new TaskManager(store, 1);
    manager.gitFinalization = {
      finalize: async (_taskId, _project, _request, transition) => {
        transition('committing');
        throw new Error('simulated Git credential failure');
      },
    };
    server = await startApi(store, manager);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${fixture.task.id}/commit-changes`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, 'COMMIT_CHANGES_FAILED');
    assert.notEqual(body.code, 'INTERNAL_ERROR');
    assert.match(body.nextAction, /Correct the reported Git problem/);
    assert.equal(store.getTask(fixture.task.id).state, 'paused');
    assert.ok(store.listEvents(fixture.task.id).some((event) => event.type === 'warning' && event.payload.code === 'COMMIT_CHANGES_FAILED'));
  } finally {
    if (server) await closeServer(server);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Commit & Push Changes preserves a successful local commit when no upstream exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-manual-unpushed-'));
  const projectRoot = join(root, 'project');
  const store = new Store(join(root, 'orchestra.db'));
  try {
    initializeRepository(projectRoot);
    writeFileSync(join(projectRoot, 'app.ts'), 'export const value = 3;\n');
    const fixture = createCommitReadyTask(store, projectRoot);
    const manager = new TaskManager(store, 1);

    const result = await manager.commitUncommittedChanges(fixture.task.id);
    assert.equal(result.state, 'completed_unpushed');
    assert.equal(result.pushStatus, 'unpushed');
    assert.equal(git(projectRoot, ['status', '--porcelain']), '');
    assert.equal(git(projectRoot, ['rev-list', '--count', 'HEAD']), '2');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('simple finalization bypasses local models, semantic slicing, diff generation, and HANDOFF updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-simple-finalizer-'));
  const store = new Store(join(root, 'orchestra.db'));
  try {
    const fixture = createCommitReadyTask(store, root);
    const transitions = [];
    const events = [];
    const forbidden = () => { throw new Error('This dependency must not run for a manual commit.'); };
    const service = new GitFinalizationService(store, {
      status: async () => ({
        isGit: true,
        root,
        branch: 'main',
        head: '1'.repeat(40),
        upstream: 'origin/main',
        dirty: true,
        files: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }],
      }),
      diff: forbidden,
      summarize: forbidden,
      handoff: forbidden,
      slice: forbidden,
      commit: async (_root, paths, title, body) => {
        assert.deepEqual(paths, ['src/app.ts']);
        assert.equal(title, 'chore: commit uncommitted changes');
        assert.match(body, /1 uncommitted project file/);
        return 'c'.repeat(40);
      },
      push: async () => ({ pushed: true, error: null }),
    });

    const result = await service.finalize(
      fixture.task.id,
      fixture.project,
      fixture.task.prompt,
      (state) => transitions.push(state),
      (agent, type, payload) => events.push({ agent, type, payload }),
      { simple: true },
    );
    assert.deepEqual(result, { status: 'committed', commitSha: 'c'.repeat(40), pushStatus: 'pushed', branch: 'main' });
    assert.deepEqual(transitions, ['committing', 'pushing']);
    assert.ok(events.every((event) => event.agent === 'git'));
    assert.equal(store.getTask(fixture.task.id).commitSha, 'c'.repeat(40));
    assert.equal(store.getTask(fixture.task.id).pushStatus, 'pushed');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a push exception after commit is recorded as unpushed instead of losing the successful commit result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-simple-push-error-'));
  const store = new Store(join(root, 'orchestra.db'));
  try {
    const fixture = createCommitReadyTask(store, root);
    const service = new GitFinalizationService(store, {
      status: async () => ({ isGit: true, root, branch: 'main', head: '1'.repeat(40), upstream: 'origin/main', dirty: true,
        files: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }] }),
      commit: async () => 'd'.repeat(40),
      push: async () => { throw new Error('credential helper timed out'); },
    });

    const result = await service.finalize(fixture.task.id, fixture.project, fixture.task.prompt, () => {}, () => {}, { simple: true });
    assert.deepEqual(result, { status: 'committed', commitSha: 'd'.repeat(40), pushStatus: 'unpushed', branch: 'main' });
    assert.equal(store.getTask(fixture.task.id).commitSha, 'd'.repeat(40));
    assert.equal(store.getTask(fixture.task.id).pushStatus, 'unpushed');
    const operation = store.manager.gitOperations.listByProject(fixture.project.id)[0];
    assert.equal(operation.pushStatus, 'unpushed');
    assert.match(operation.error, /credential helper timed out/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual commit summary is deterministic and contains no user prompt', () => {
  const summary = simpleChangeSummary(['src/app.ts', 'tests/app.test.ts']);
  assert.equal(summary.title, 'chore: commit uncommitted changes');
  assert.equal(summary.summary, "Commit 2 uncommitted project files at the user's request.");
});

test('pre-existing changes use the explicit commit action without a hidden model-driven baseline path', () => {
  const taskSource = readFileSync(join(process.cwd(), 'server', 'tasks.ts'), 'utf8');
  const routeSource = readFileSync(join(process.cwd(), 'server', 'api', 'routes', 'tasks.ts'), 'utf8');
  assert.match(taskSource, /Use Commit & Push Changes to commit them/);
  assert.doesNotMatch(taskSource, /resolveBaseline|Auto-committed baseline|Review and preserve existing working tree modifications/);
  assert.doesNotMatch(routeSource, /\/projects\/:id\/baseline/);
});
