import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { Store } from '../dist-server/db.js';
import { JulesSessionManager } from '../dist-server/providers/jules/session-manager.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';
import { JulesSupervisor } from '../dist-server/providers/jules/supervisor.js';

// ============================================================================
// Phase 14 Background Cloud Supervisor & Polling Loop Test Suite
// ============================================================================

test('Phase 14 Supervisor — acquirePollingLease prevents race conditions and handles expiry', () => {
  const dbPath = join(tmpdir(), `orchestra-sup-lease-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

  try {
    const store = new Store(dbPath);
    const project = store.upsertProject({ name: 'test-sup', root: 'F:/test-sup', gitRoot: 'F:/test-sup' });
    const session = store.createSession(project.id, 'Supervisor Test');
    const task = store.createTask(project.id, session.id, 'Supervisor Lease Task', null, null, 'cloud');

    const cloudSession = store.manager.cloudSessions.create({
      taskId: task.id,
      sourceName: 'sources/github/frankr2994/antigravity-orchestra',
      sessionResourceName: 'sessions/sess-lease-1',
      remoteSessionId: 'sess-lease-1',
      dispatchBranch: 'orchestra/jules-base/task-1-sha',
      targetBranch: 'main',
      baseSha: 'base-sha-123',
      state: 'IN_PROGRESS',
    });

    // 1. First lease acquisition succeeds
    const lease1 = store.manager.cloudSessions.acquirePollingLease(cloudSession.id, 60_000);
    assert.equal(lease1, true);

    // 2. Second immediate acquisition fails (already leased)
    const lease2 = store.manager.cloudSessions.acquirePollingLease(cloudSession.id, 60_000);
    assert.equal(lease2, false);

    // 3. Release lease and re-acquire
    store.manager.cloudSessions.releasePollingLease(cloudSession.id);
    const lease3 = store.manager.cloudSessions.acquirePollingLease(cloudSession.id, 60_000);
    assert.equal(lease3, true);

    store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 14 Supervisor — tick polls active sessions and triggers onTerminal callback', async () => {
  const dbPath = join(tmpdir(), `orchestra-sup-tick-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const fixtureDir = join(tmpdir(), `orchestra-sup-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    const store = new Store(dbPath);
    const project = store.upsertProject({ name: 'test-sup', root: fixtureDir, gitRoot: fixtureDir });
    const session = store.createSession(project.id, 'Supervisor Test');
    const task = store.createTask(project.id, session.id, 'Supervisor Tick Task', null, null, 'cloud');
    store.updateTask(task.id, { state: 'running' });

    const createdCloud = store.manager.cloudSessions.create({
      taskId: task.id,
      sourceName: 'sources/github/frankr2994/antigravity-orchestra',
      sessionResourceName: 'sessions/sess-tick-1',
      remoteSessionId: 'sess-tick-1',
      dispatchBranch: 'orchestra/jules-base/task-1-sha',
      targetBranch: 'main',
      baseSha: 'base-sha-123',
      state: 'IN_PROGRESS',
    });
    assert.equal(createdCloud.remoteSessionId, 'sess-tick-1');

    let currentRemoteState = 'IN_PROGRESS';
    let prAvailable = false;
    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/activities')) {
        return { ok: true, status: 200, json: async () => ({ activities: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'sessions/sess-tick-1',
          id: 'sess-tick-1',
          state: currentRemoteState,
          outputs: currentRemoteState === 'COMPLETED' && prAvailable ? [
            {
              pullRequest: {
                url: 'https://github.com/frankr2994/antigravity-orchestra/pull/99',
                title: 'Supervisor PR',
              },
            },
          ] : undefined,
        }),
      };
    };

    const julesClient = new JulesApiClient({ apiKey: 'test-key', fetchFn: mockFetch });
    const sessionManager = new JulesSessionManager(store);

    let terminalEventReceived = null;
    let terminalEventCount = 0;
    let enabled = false;

    const supervisor = new JulesSupervisor({
      store,
      sessionManager,
      julesClient,
      isEnabled: () => enabled,
      onTerminal: (event) => {
        terminalEventReceived = event;
        terminalEventCount += 1;
        if (terminalEventCount === 2) store.updateTask(event.taskId, { state: 'completed' });
      },
    });

    // 1. Disabled: no provider polling occurs.
    const disabledTick = await supervisor.tick();
    assert.deepEqual(disabledTick, { polled: 0, active: 0, errors: 0 });

    // 2. Enabled: in-progress work resumes without reconstructing the supervisor.
    enabled = true;
    const tick1 = await supervisor.tick();
    assert.equal(tick1.polled, 1);
    assert.equal(tick1.active, 1);
    assert.equal(terminalEventReceived, null);

    // 3. Tick 2: Completed
    const cursor = store.manager.activityCursors.get(createdCloud.id);
    store.manager.activityCursors.compareAndSet(createdCloud.id, cursor.version, {
      nextPollAt: '2000-01-01T00:00:00.000Z', consecutiveFailures: 0,
      lastActivityId: cursor.lastActivityId, lastActivityAt: cursor.lastActivityAt,
    });
    currentRemoteState = 'COMPLETED';
    const tick2 = await supervisor.tick();
    assert.equal(tick2.polled, 1);
    assert.ok(terminalEventReceived);
    assert.equal(terminalEventReceived?.taskId, task.id);
    assert.equal(terminalEventReceived?.prUrl, undefined, 'provider completion can precede PR artifact propagation');

    // 4. A completed provider session remains due until the local handoff
    // reaches a terminal Orchestra state, making callback failures restart-safe.
    prAvailable = true;
    const tick3 = await supervisor.tick();
    assert.equal(tick3.polled, 1);
    assert.equal(tick3.active, 0);
    assert.equal(terminalEventCount, 2);
    assert.equal(terminalEventReceived?.prUrl, 'https://github.com/frankr2994/antigravity-orchestra/pull/99');

    const tick4 = await supervisor.tick();
    assert.equal(tick4.polled, 0);

    // 5. Lifecycle start and stop
    supervisor.start();
    supervisor.stop();

    store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 14 Supervisor — non-retryable PR identity conflicts stop polling with an actionable dispute', async () => {
  const dbPath = join(tmpdir(), `orchestra-sup-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  try {
    const project = store.upsertProject({ name: 'conflict', root: 'F:/conflict', gitRoot: 'F:/conflict' });
    const conversation = store.createSession(project.id, 'Conflict');
    const task = store.createTask(project.id, conversation.id, 'Review Jules conflict', null, null, 'cloud');
    store.updateTask(task.id, { state: 'running' }); store.updateTask(task.id, { state: 'reviewing' });
    const cloud = store.manager.cloudSessions.create({ taskId: task.id, sourceName: 'sources/test', sessionResourceName: 'sessions/conflict',
      remoteSessionId: 'conflict', dispatchBranch: 'orchestra/jules/conflict', targetBranch: 'main', baseSha: 'a'.repeat(40),
      state: 'COMPLETED', prUrl: 'https://github.com/example/repository/pull/1' });
    store.manager.cloudSessions.update(cloud.id, { prUrl: 'https://github.com/example/repository/pull/1' });
    store.manager.activityCursors.ensure(cloud.id);
    store.manager.julesCapacity.restore(task.id);
    const supervisor = new JulesSupervisor({
      store,
      sessionManager: new JulesSessionManager(store),
      onTerminal: () => {
        const error = new Error('The target branch changed after dispatch.');
        error.code = 'TARGET_BRANCH_MOVED';
        throw error;
      },
    });
    const result = await supervisor.tick();
    assert.equal(result.errors, 1);
    assert.equal(store.getTask(task.id).state, 'review_disputed');
    assert.match(store.getTask(task.id).error, /target branch changed/i);
    assert.equal(store.manager.activityCursors.get(cloud.id).nextPollAt, '9999-12-31T23:59:59.999Z');
    assert.equal(store.manager.julesCapacity.activeCount(), 0);
  } finally {
    store.close(); try { rmSync(dbPath, { force: true }); } catch {}
  }
});
