import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Store } from '../dist-server/db.js';
import { git } from '../dist-server/git.js';
import { JulesBatchService } from '../dist-server/application/jules/batch-service.js';
import { JulesReviewService } from '../dist-server/application/jules/review-service.js';
import { parseBatchDispatchRequest } from '../dist-server/application/jules/requests.js';

test('Parallel Jules workflows launch independent nodes within capacity and release dependencies', async () => {
  const dbPath = join(tmpdir(), `orchestra-batch-${Date.now()}-${Math.random()}.db`);
  const store = new Store(dbPath);
  try {
    const project = store.upsertProject({ name: 'batch', root: 'F:/batch', gitRoot: 'F:/batch' });
    const calls = [];
    const sessions = { dispatch: async (projectId, command) => {
      calls.push(command.prompt); const session = store.createSession(projectId, command.prompt);
      const task = store.createTask(projectId, session.id, command.prompt, null, null, 'cloud');
      return { taskId: task.id };
    } };
    const service = new JulesBatchService(store, sessions);
    const command = parseBatchDispatchRequest({ idempotencyKey: 'batch-1', maxConcurrency: 2, items: [
      { prompt: 'Inspect API' }, { prompt: 'Inspect database' }, { prompt: 'Integrate findings', dependsOn: [0, 1] },
    ] });
    const batch = await service.createAndLaunch(project.id, command);
    assert.deepEqual(calls.sort(), ['Inspect API', 'Inspect database']);
    assert.deepEqual(batch.nodes.map((node) => node.state), ['running', 'running', 'queued']);
    for (const node of batch.nodes.slice(0, 2)) {
      store.updateTask(node.taskId, { state: 'running' }); store.updateTask(node.taskId, { state: 'completed' });
      await service.reconcileTask(node.taskId);
    }
    const advanced = service.get(batch.id);
    assert.equal(calls.includes('Integrate findings'), true);
    assert.equal(advanced.nodes[2].state, 'running');
    assert.throws(() => parseBatchDispatchRequest({ idempotencyKey: 'cycle', items: [
      { prompt: 'A', dependsOn: [1] }, { prompt: 'B', dependsOn: [0] },
    ] }), /acyclic/i);
  } finally { store.close(); try { rmSync(dbPath, { force: true }); } catch {} }
});

test('Exact Jules PR review verifies, independently reviews, and fast-forwards the intended target', async () => {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = join(tmpdir(), `orchestra-review-${key}.db`); const repo = join(tmpdir(), `orchestra-review-${key}`); const bare = `${repo}.git`;
  mkdirSync(repo, { recursive: true }); mkdirSync(bare, { recursive: true });
  const store = new Store(dbPath);
  try {
    await git(['init', '--bare'], bare); await git(['init'], repo); await git(['config', 'user.name', 'Orchestra Test'], repo); await git(['config', 'user.email', 'test@orchestra.local'], repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(repo, 'base.txt'), 'base'); await git(['add', '.'], repo); await git(['commit', '-m', 'base'], repo); await git(['branch', '-M', 'main'], repo);
    const baseSha = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim(); await git(['remote', 'add', 'origin', bare], repo); await git(['push', '-u', 'origin', 'main'], repo);
    writeFileSync(join(repo, 'feature.txt'), 'reviewed feature'); await git(['add', '.'], repo); await git(['commit', '-m', 'feature'], repo);
    const headSha = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim(); await git(['push', 'origin', `${headSha}:refs/pull/1/head`], repo);

    const project = store.upsertProject({ name: 'review', root: repo, gitRoot: repo }); const conversation = store.createSession(project.id, 'review');
    const task = store.createTask(project.id, conversation.id, 'Implement reviewed feature', null, null, 'cloud'); store.updateTask(task.id, { state: 'running' }); store.updateTask(task.id, { state: 'reviewing' });
    const attempt = store.manager.attempts.create({ taskId: task.id, target: 'cloud', worker: 'jules', baseSha, providerSessionId: 'remote-1', branchName: 'orchestra/jules/test/aaaaaaaaaaaa' });
    store.manager.cloudSessions.create({ taskId: task.id, attemptId: attempt.id, sourceName: 'sources/opaque', sessionResourceName: 'sessions/remote-1', remoteSessionId: 'remote-1', dispatchBranch: 'orchestra/jules/test/aaaaaaaaaaaa', targetBranch: 'main', baseSha, state: 'COMPLETED' });
    const cloud = store.manager.cloudSessions.getByTaskId(task.id); store.manager.cloudSessions.update(cloud.id, { prUrl: 'https://github.com/example/repository/pull/1' });
    store.manager.julesSourceMappings.upsert({ projectId: project.id, sourceName: 'sources/opaque', githubOwner: 'example', githubRepo: 'repository', startingBranch: 'main', targetBranch: 'main' });
    store.manager.julesCapacity.restore(task.id);
    const service = new JulesReviewService(store, { codexRunner: async () => 'VERDICT: PASS\nReviewed exact diff; no blockers.' });
    const result = await service.reviewAndIntegrate(task.id);
    assert.equal(result.ok, true); assert.equal(result.headSha, headSha);
    const remoteMain = await git(['ls-remote', '--heads', bare, 'refs/heads/main'], repo);
    assert.equal(remoteMain.stdout.trim().split(/\s+/)[0], headSha);
    assert.equal(store.getTask(task.id).state, 'completed'); assert.equal(store.manager.julesCapacity.activeCount(), 0);
    assert.equal(store.manager.evidence.list(task.id, 'integration')[0].subjectSha, headSha);
  } finally {
    store.close(); try { rmSync(dbPath, { force: true }); } catch {}
    try { rmSync(repo, { recursive: true, force: true }); } catch {} try { rmSync(bare, { recursive: true, force: true }); } catch {}
  }
});
