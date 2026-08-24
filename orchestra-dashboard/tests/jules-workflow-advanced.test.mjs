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
    await git(['reset', '--hard', baseSha], repo);

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
    assert.equal((await git(['rev-parse', 'main'], repo)).stdout.trim(), headSha, 'local target must follow the reviewed PR head');
    assert.equal((await git(['rev-parse', 'HEAD'], repo)).stdout.trim(), headSha, 'checked-out target must be fast-forwarded locally');
    assert.equal(store.getTask(task.id).state, 'completed'); assert.equal(store.manager.julesCapacity.activeCount(), 0);
    assert.equal(store.getTask(task.id).commitSha, headSha); assert.equal(store.getTask(task.id).pushStatus, 'pushed');
    assert.equal(store.manager.evidence.list(task.id, 'integration')[0].subjectSha, headSha);
  } finally {
    store.close(); try { rmSync(dbPath, { force: true }); } catch {}
    try { rmSync(repo, { recursive: true, force: true }); } catch {} try { rmSync(bare, { recursive: true, force: true }); } catch {}
  }
});

test('Blocked Jules review imports the exact PR head before requesting a real local repair', async () => {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = join(tmpdir(), `orchestra-takeover-${key}.db`); const repo = join(tmpdir(), `orchestra-takeover-${key}`); const bare = `${repo}.git`;
  mkdirSync(repo, { recursive: true }); mkdirSync(bare, { recursive: true });
  const store = new Store(dbPath);
  try {
    await git(['init', '--bare'], bare); await git(['init'], repo); await git(['config', 'user.name', 'Orchestra Test'], repo); await git(['config', 'user.email', 'test@orchestra.local'], repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(repo, 'base.txt'), 'base'); await git(['add', '.'], repo); await git(['commit', '-m', 'base'], repo); await git(['branch', '-M', 'main'], repo);
    const baseSha = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim(); await git(['remote', 'add', 'origin', bare], repo); await git(['push', '-u', 'origin', 'main'], repo);
    writeFileSync(join(repo, 'feature.txt'), 'needs repair'); await git(['add', '.'], repo); await git(['commit', '-m', 'jules feature'], repo);
    const headSha = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim(); await git(['push', 'origin', `${headSha}:refs/pull/2/head`], repo); await git(['reset', '--hard', baseSha], repo);

    const project = store.upsertProject({ name: 'takeover', root: repo, gitRoot: repo }); const conversation = store.createSession(project.id, 'takeover');
    const classification = JSON.stringify({ type: 'implementation', mutating: true, complexity: 'normal', riskFlags: [], codexRole: 'review', target: 'cloud', title: 'Repair Jules feature' });
    const task = store.createTask(project.id, conversation.id, 'Repair Jules feature', classification, null, 'cloud'); store.updateTask(task.id, { state: 'running' }); store.updateTask(task.id, { state: 'reviewing' });
    const attempt = store.manager.attempts.create({ taskId: task.id, target: 'cloud', worker: 'jules', baseSha, providerSessionId: 'remote-2', branchName: 'orchestra/jules/test/bbbbbbbbbbbb' });
    store.manager.cloudSessions.create({ taskId: task.id, attemptId: attempt.id, sourceName: 'sources/opaque', sessionResourceName: 'sessions/remote-2', remoteSessionId: 'remote-2', dispatchBranch: 'orchestra/jules/test/bbbbbbbbbbbb', targetBranch: 'main', baseSha, state: 'COMPLETED' });
    const cloud = store.manager.cloudSessions.getByTaskId(task.id); store.manager.cloudSessions.update(cloud.id, { prUrl: 'https://github.com/example/repository/pull/2' });
    store.manager.julesSourceMappings.upsert({ projectId: project.id, sourceName: 'sources/opaque', githubOwner: 'example', githubRepo: 'repository', startingBranch: 'main', targetBranch: 'main' });
    store.manager.julesCapacity.restore(task.id);
    const service = new JulesReviewService(store, {
      codexRunner: async () => '- [BLOCKING] feature.txt:1 Repair the implementation before integration.\n\nVERDICT: BLOCK',
      repairHandler: async () => ({ strategy: 'local_takeover', ok: true, cycle: 3 }),
    });
    const result = await service.reviewAndIntegrate(task.id);
    assert.equal(result.stage, 'local_takeover');
    assert.equal((await git(['rev-parse', 'HEAD'], repo)).stdout.trim(), headSha);
    assert.equal(store.getTask(task.id).target, 'local');
    assert.equal(store.getTask(task.id).state, 'recovery_required');
    const checkpoint = store.manager.checkpoints.latest(task.id, 'local_takeover');
    assert.equal(checkpoint.subjectSha, headSha);
    assert.equal(checkpoint.data.baseSha, baseSha);
    assert.equal(checkpoint.data.status, 'prepared');
    assert.equal(store.manager.attempts.listByTaskId(task.id).filter((item) => item.target === 'local').length, 0,
      'the executor creates the local attempt only after the exact head is prepared');
  } finally {
    store.close(); try { rmSync(dbPath, { force: true }); } catch {}
    try { rmSync(repo, { recursive: true, force: true }); } catch {} try { rmSync(bare, { recursive: true, force: true }); } catch {}
  }
});
