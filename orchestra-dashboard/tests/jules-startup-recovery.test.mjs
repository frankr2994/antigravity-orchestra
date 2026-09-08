import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Store } from '../dist-server/db.js';
import { automaticInterruptedLocalRecoveryTaskIds, reconcileStartupTasks } from '../dist-server/bootstrap/recovery.js';
import { codexCapacityRetryDelay, isCodexCapacityFailure, parseCodexCapacityRetry } from '../dist-server/application/tasks/task-execution-coordinator.js';

test('Jules startup recovery releases only orphaned process-local review leases', async () => {
  const dbPath = join(tmpdir(), `orchestra-jules-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  try {
    const root = 'F:/acceptance-fixture';
    const stale = store.manager.leases.acquire('git_repository', root, 'jules-review-prior-process', 60 * 60_000);
    const unrelated = store.manager.leases.acquire('git_repository', 'F:/other-fixture', 'ordinary-live-owner', 60 * 60_000);
    assert.ok(stale); assert.ok(unrelated);

    await reconcileStartupTasks(store);

    assert.ok(store.manager.leases.acquire('git_repository', root, 'jules-review-new-process', 60_000));
    assert.equal(store.manager.leases.acquire('git_repository', 'F:/other-fixture', 'another-owner', 60_000), null);
  } finally {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Codex capacity waits validate before recovery and repair only the legacy capacity failure', async () => {
  assert.equal(isCodexCapacityFailure("You've hit your usage limit. Try again at 10:54 AM."), true);
  assert.equal(isCodexCapacityFailure('The reviewer found a blocking API defect.'), false);
  assert.equal(codexCapacityRetryDelay(0), 60_000);
  assert.equal(codexCapacityRetryDelay(99), 15 * 60_000);
  assert.equal(parseCodexCapacityRetry({ version: 1, attempts: 2, retryAt: '2026-08-31T12:00:00.000Z', reason: 'quota' })?.attempts, 2);
  assert.equal(parseCodexCapacityRetry({ version: 1, attempts: '2', retryAt: 'bad', reason: 'quota' }), null);

  const dbPath = join(tmpdir(), `orchestra-capacity-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  try {
    const project = store.upsertProject({ name: 'Capacity fixture', root: 'F:/capacity-fixture', gitRoot: null });
    const session = store.createSession(project.id, 'Capacity Session');
    const retryable = store.createTask(project.id, session.id, 'Implement the requested feature');
    const ordinaryFailure = store.createTask(project.id, session.id, 'Implement another feature');
    store.updateTask(retryable.id, { state: 'failed', error: "Codex turn failed: You've hit your usage limit. Try again at 10:54 AM." });
    store.updateTask(ordinaryFailure.id, { state: 'failed', error: 'Codex turn failed: reviewer rejected the API contract.' });

    await reconcileStartupTasks(store);

    assert.equal(store.getTask(retryable.id)?.state, 'recovery_required');
    assert.match(store.getTask(retryable.id)?.error || '', /resume automatically/i);
    const retry = parseCodexCapacityRetry(store.manager.checkpoints.latest(retryable.id, 'codex_capacity_retry')?.data);
    assert.equal(retry?.attempts, 1);
    assert.ok(Date.parse(retry?.retryAt || '') >= Date.now());
    assert.equal(store.getTask(ordinaryFailure.id)?.state, 'failed');
  } finally {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('only restart-marked local work is automatically re-enqueued after recovery', () => {
  const dbPath = join(tmpdir(), `orchestra-interrupted-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  try {
    const project = store.upsertProject({ name: 'Interrupted fixture', root: 'F:/interrupted-fixture', gitRoot: null });
    const session = store.createSession(project.id, 'Interrupted Session');
    const restarted = store.createTask(project.id, session.id, 'Implement the requested feature');
    const userPaused = store.createTask(project.id, session.id, 'Implement another feature');
    const takeover = store.createTask(project.id, session.id, 'Repair imported Jules head');
    store.updateTask(restarted.id, { state: 'running' });
    store.updateTask(userPaused.id, { state: 'running' });
    store.updateTask(takeover.id, { state: 'running' });
    store.updateTask(restarted.id, { state: 'recovery_required', error: 'The dashboard restarted during this task. Its uncommitted project changes were preserved.' });
    store.updateTask(userPaused.id, { state: 'recovery_required', error: 'The user stopped the task and preserved project changes.' });
    store.updateTask(takeover.id, { state: 'recovery_required', error: 'The dashboard restarted during this task. Its uncommitted project changes were preserved.' });
    store.manager.checkpoints.append({ taskId: takeover.id, stage: 'local_takeover', subjectSha: 'a'.repeat(40), data: { status: 'prepared' } });

    assert.deepEqual(automaticInterruptedLocalRecoveryTaskIds(store), [restarted.id]);
  } finally {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});
