import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { DatabaseManager, runMigrations } from '../dist-server/infrastructure/database/index.js';

function withManager(run) {
  const path = join(tmpdir(), `orchestra-durable-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const manager = new DatabaseManager(path);
  try { return run(manager); } finally { manager.close(); rmSync(path, { force: true }); }
}

function fixture(manager) {
  const project = manager.projects.upsert({ name: 'Durable', root: `/tmp/durable-${Math.random()}`, gitRoot: '/tmp/durable' });
  const session = manager.sessions.create(project.id, 'Durable session');
  const task = manager.tasks.create(project.id, session.id, 'Durable workflow', null, null, 'cloud');
  const attempt = manager.attempts.create({ taskId: task.id, target: 'cloud', worker: 'jules', baseSha: 'a'.repeat(40) });
  const cloud = manager.cloudSessions.create({
    taskId: task.id, sourceName: 'sources/repo', sessionResourceName: 'sessions/remote-1',
    attemptId: attempt.id,
    remoteSessionId: `remote-${Math.random()}`, dispatchBranch: 'orchestra/dispatch/1', targetBranch: 'main', baseSha: 'a'.repeat(40),
  });
  return { task, attempt, cloud };
}

test('Durable persistence — a failed migration rolls back schema and version atomically', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => runMigrations(db, [{
    version: 1, name: 'fault', up(database) { database.exec('CREATE TABLE partial_write (id TEXT)'); throw new Error('injected'); },
  }]), /injected/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='partial_write'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 0);
  db.close();
});

test('Durable persistence — unknown and mismatched migration histories fail closed', () => {
  const newer = new DatabaseSync(':memory:');
  newer.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (99,'future','now')");
  assert.throws(() => runMigrations(newer), /newer than supported/);
  newer.close();

  const mismatched = new DatabaseSync(':memory:');
  mismatched.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1,'wrong-name','now')");
  assert.throws(() => runMigrations(mismatched), /identity mismatch/);
  mismatched.close();
});

test('Durable persistence — unit of work rolls back intent and checkpoint together', () => withManager((manager) => {
  const { task, attempt } = fixture(manager);
  const hash = manager.commandIntents.constructor.requestHash({ prompt: 'safe' });
  assert.throws(() => manager.transaction(() => {
    manager.commandIntents.createOrGet({ taskId: task.id, attemptId: attempt.id, kind: 'dispatch', idempotencyKey: 'dispatch-1', requestHash: hash });
    manager.checkpoints.append({ taskId: task.id, attemptId: attempt.id, stage: 'dispatch', data: { status: 'pending' } });
    throw new Error('injected transaction failure');
  }), /injected/);
  assert.equal(manager.commandIntents.getByIdempotencyKey('dispatch-1'), null);
  assert.equal(manager.checkpoints.latest(task.id, 'dispatch'), null);
}));

test('Durable persistence — command idempotency rejects conflicting reuse and persists safe outcomes', () => withManager((manager) => {
  const { task, attempt } = fixture(manager);
  const requestHash = manager.commandIntents.constructor.requestHash({ prompt: 'one' });
  const first = manager.commandIntents.createOrGet({ taskId: task.id, attemptId: attempt.id, kind: 'dispatch', idempotencyKey: 'same', requestHash });
  const replay = manager.commandIntents.createOrGet({ taskId: task.id, attemptId: attempt.id, kind: 'dispatch', idempotencyKey: 'same', requestHash });
  assert.equal(first.created, true); assert.equal(replay.created, false); assert.equal(replay.intent.id, first.intent.id);
  assert.throws(() => manager.commandIntents.createOrGet({
    taskId: task.id, attemptId: attempt.id, kind: 'dispatch', idempotencyKey: 'same',
    requestHash: manager.commandIntents.constructor.requestHash({ prompt: 'different' }),
  }), /different command/);
  const completed = manager.commandIntents.transition(first.intent.id, 'pending', 'acknowledged', {
    providerResource: 'sessions/one', response: { authorization: 'Bearer hidden' },
  });
  assert.equal(completed.state, 'acknowledged');
  assert.equal(JSON.stringify(completed.response).includes('hidden'), false);
}));

test('Durable persistence — cursors use compare-and-set and leases fence stale owners', () => withManager((manager) => {
  const { cloud } = fixture(manager);
  const cursor = manager.activityCursors.ensure(cloud.id, '2026-01-01T00:00:00.000Z');
  const advanced = manager.activityCursors.compareAndSet(cloud.id, cursor.version, {
    nextPageToken: 'next', lastActivityId: 'activities/1', lastActivityAt: '2026-01-01T00:00:01.000Z',
    nextPollAt: '2026-01-01T00:00:02.000Z', consecutiveFailures: 0,
  });
  assert.equal(advanced.version, 1);
  assert.throws(() => manager.activityCursors.compareAndSet(cloud.id, 0, {
    nextPollAt: '2026-01-01T00:00:03.000Z', consecutiveFailures: 1,
  }), /concurrently/);

  const at = new Date('2026-01-01T00:00:00.000Z');
  const first = manager.leases.acquire('cloud-poll', cloud.id, 'worker-a', 1000, at);
  assert.equal(first.fencingToken, 1);
  assert.equal(manager.leases.acquire('cloud-poll', cloud.id, 'worker-b', 1000, new Date(at.getTime() + 500)), null);
  const second = manager.leases.acquire('cloud-poll', cloud.id, 'worker-b', 1000, new Date(at.getTime() + 1001));
  assert.equal(second.fencingToken, 2);
  assert.throws(() => manager.leases.assertFence('cloud-poll', cloud.id, 'worker-a', 1, new Date(at.getTime() + 1002).toISOString()), /Stale lease/);
  assert.equal(manager.leases.release('cloud-poll', cloud.id, 'worker-a', 1), false);
  assert.equal(manager.leases.release('cloud-poll', cloud.id, 'worker-b', 2), true);
  const reacquired = manager.leases.acquire('cloud-poll', cloud.id, 'worker-b', 1000, new Date(at.getTime() + 1003));
  assert.equal(reacquired.fencingToken, 3, 'fencing tokens must never be reused after release');
}));

test('Durable persistence — Git ownership, SHA evidence, and outbox state are recoverable', () => withManager((manager) => {
  const { task, attempt } = fixture(manager);
  const resource = manager.managedGitResources.register({
    taskId: task.id, attemptId: attempt.id, repositoryRoot: 'C:/repo', kind: 'worktree', resourceValue: 'C:/repo/.worktrees/task',
  });
  assert.equal(manager.managedGitResources.scheduleCleanup(resource.id, '2026-01-01T00:00:00.000Z').state, 'cleanup_pending');
  assert.equal(manager.managedGitResources.listCleanupDue('2026-01-02T00:00:00.000Z').length, 1);

  const sha = 'b'.repeat(40);
  const evidence = manager.evidence.record({ taskId: task.id, attemptId: attempt.id, kind: 'review', subjectSha: sha,
    outcome: 'pass', payload: { token: 'secret' } });
  assert.equal(evidence.subjectSha, sha);
  assert.equal(evidence.payload.token, '[REDACTED]');
  assert.throws(() => manager.evidence.record({ taskId: task.id, attemptId: attempt.id, kind: 'review', subjectSha: sha,
    outcome: 'pass', payload: {} }), /UNIQUE/);

  const queued = manager.outbox.enqueue(task.id, 'task.changed', { password: 'hidden' }, '2026-01-01T00:00:00.000Z');
  assert.equal(queued.payload.password, '[REDACTED]');
  const claimed = manager.outbox.claimDue('2026-01-02T00:00:00.000Z');
  assert.equal(claimed[0].state, 'publishing');
  assert.equal(manager.outbox.finish(claimed[0].id, true).state, 'published');
}));
