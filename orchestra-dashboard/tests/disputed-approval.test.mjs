import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist-server/db.js';
import { TaskManager } from '../dist-server/tasks.js';
import {
  GitFinalizationService,
  deterministicChangeSummary,
} from '../dist-server/application/git/git-finalization-service.js';
import { createTasksRouter } from '../dist-server/api/routes/tasks.js';
import { errorHandlerMiddleware } from '../dist-server/api/middleware/error.js';

const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

function createDisputedTask(store, root) {
  const project = store.upsertProject({ name: 'Approval fixture', root, gitRoot: root });
  const session = store.createSession(project.id, 'Approval fixture');
  const task = store.createTask(project.id, session.id, 'Implement the reviewed change');
  store.updateTask(task.id, { state: 'running' });
  store.updateTask(task.id, { state: 'review_disputed' });
  return { project, session, task: store.getTask(task.id) };
}

test('disputed approval is idempotent after completion and never returns INTERNAL_ERROR for a missing diff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-disputed-api-'));
  const store = new Store(join(root, 'orchestra.db'));
  let server;
  try {
    const first = createDisputedTask(store, join(root, 'not-a-repository'));
    const manager = new TaskManager(store, 1);
    const app = express();
    app.use(express.json());
    app.use('/api', createTasksRouter(store, manager));
    app.use(errorHandlerMiddleware);
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/tasks/${first.task.id}/approve-disputed`;

    const missing = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const missingBody = await missing.json();
    assert.equal(missing.status, 409);
    assert.equal(missingBody.code, 'DISPUTED_PROJECT_NOT_GIT');
    assert.notEqual(missingBody.code, 'INTERNAL_ERROR');
    assert.match(missingBody.nextAction, /Restore the Git repository/);
    assert.equal(store.getTask(first.task.id).state, 'review_disputed');

    store.updateTask(first.task.id, { state: 'committing', commitSha: 'a'.repeat(40), pushStatus: 'pushed' });
    store.updateTask(first.task.id, { state: 'completed', result: 'Already finalized.' });
    const repeated = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(repeated.status, 202);
    assert.equal((await repeated.json()).state, 'completed');
  } finally {
    if (server) await closeServer(server);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('disputed approval completes from an explicit finalization result and repeat calls reconcile safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-disputed-success-'));
  const store = new Store(join(root, 'orchestra.db'));
  try {
    const fixture = createDisputedTask(store, root);
    const manager = new TaskManager(store, 1);
    let finalizationCalls = 0;
    manager.gitFinalization = {
      finalize: async (taskId, _project, _request, transition) => {
        finalizationCalls += 1;
        transition('committing');
        store.updateTask(taskId, { commitSha: 'b'.repeat(40) });
        transition('pushing');
        store.updateTask(taskId, { pushStatus: 'pushed' });
        return { status: 'committed', commitSha: 'b'.repeat(40), pushStatus: 'pushed', branch: 'main' };
      },
    };

    const approved = await manager.approveDisputed(fixture.task.id);
    assert.equal(approved.state, 'completed');
    assert.equal(approved.commitSha, 'b'.repeat(40));
    assert.match(approved.result, /finalized in commit bbbbbbbb/);
    assert.equal((await manager.approveDisputed(fixture.task.id)).state, 'completed');
    assert.equal(finalizationCalls, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('operational finalization failures return an actionable API error and preserve the dispute', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-disputed-failure-'));
  const store = new Store(join(root, 'orchestra.db'));
  let server;
  try {
    const fixture = createDisputedTask(store, root);
    const manager = new TaskManager(store, 1);
    manager.gitFinalization = {
      finalize: async (_taskId, _project, _request, transition) => {
        transition('summarizing');
        throw new Error('simulated Git credential failure');
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createTasksRouter(store, manager));
    app.use(errorHandlerMiddleware);
    server = app.listen(0);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${fixture.task.id}/approve-disputed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.code, 'DISPUTED_APPROVAL_FAILED');
    assert.notEqual(body.code, 'INTERNAL_ERROR');
    assert.match(body.nextAction, /failed Git phase/);
    assert.equal(store.getTask(fixture.task.id).state, 'review_disputed');
    assert.ok(store.listEvents(fixture.task.id).some((event) => event.type === 'warning' && event.payload.code === 'DISPUTED_APPROVAL_FAILED'));
  } finally {
    if (server) await closeServer(server);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git finalization keeps local-model summaries enabled but falls back without blocking approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-finalization-fallback-'));
  const store = new Store(join(root, 'orchestra.db'));
  try {
    const fixture = createDisputedTask(store, root);
    const statuses = [
      { isGit: true, root, branch: 'main', head: '1'.repeat(40), upstream: 'origin/main', dirty: true,
        files: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }] },
      { isGit: true, root, branch: 'main', head: '1'.repeat(40), upstream: 'origin/main', dirty: true,
        files: [{ path: 'src/app.ts', index: ' ', worktree: 'M' }, { path: 'docs/HANDOFF.md', index: '?', worktree: '?' }] },
    ];
    const events = [];
    const transitions = [];
    const service = new GitFinalizationService(store, {
      status: async () => statuses.shift(),
      diff: async () => 'diff --git a/src/app.ts b/src/app.ts',
      summarize: async () => { throw new Error('LM Studio temporarily unavailable'); },
      handoff: () => {},
      slice: async () => { throw new Error('local semantic slicing unavailable'); },
      commit: async () => 'c'.repeat(40),
      push: async () => ({ pushed: true, error: null }),
    });

    const result = await service.finalize(
      fixture.task.id,
      fixture.project,
      fixture.task.prompt,
      (state) => transitions.push(state),
      (agent, type, payload) => events.push({ agent, type, payload }),
    );
    assert.deepEqual(result, { status: 'committed', commitSha: 'c'.repeat(40), pushStatus: 'pushed', branch: 'main' });
    assert.deepEqual(transitions, ['summarizing', 'committing', 'pushing']);
    assert.ok(events.some((event) => event.agent === 'gemma' && event.type === 'warning' && /deterministic summary/.test(event.payload.message)));
    assert.equal(store.getTask(fixture.task.id).commitSha, 'c'.repeat(40));
    assert.equal(store.getTask(fixture.task.id).pushStatus, 'pushed');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('deterministic finalization summary is bounded and does not copy the user prompt', () => {
  const summary = deterministicChangeSummary(Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`));
  assert.equal(summary.title, 'chore: finalize reviewed changes');
  assert.match(summary.summary, /12 project files/);
  assert.match(summary.summary, /and 4 more/);
});
