import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { git } from '../dist-server/git.js';
import { Store } from '../dist-server/db.js';
import { JulesSessionManager } from '../dist-server/providers/jules/session-manager.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';
import { generateDispatchBranchName } from '../dist-server/providers/jules/preflight.js';

// ============================================================================
// Phase 10 Jules Cloud Session Lifecycle Manager Test Suite
// ============================================================================

test('Phase 10 Session Manager — dispatchSession, pollSession and cancelSession lifecycle', async () => {
  const dbPath = join(tmpdir(), `orchestra-sm-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const fixtureDir = join(tmpdir(), `orchestra-sm-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const bareDir = join(tmpdir(), `orchestra-sm-bare-${Date.now()}-${Math.random().toString(36).slice(2)}.git`);
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(bareDir, { recursive: true });

  try {
    // 1. Initialize git bare origin and working repo fixture
    await git(['init', '--bare'], bareDir);

    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    writeFileSync(join(fixtureDir, 'README.md'), '# Session Manager Test');
    await git(['add', 'README.md'], fixtureDir);
    await git(['commit', '-m', 'Initial commit'], fixtureDir);
    await git(['branch', '-M', 'main'], fixtureDir);

    await git(['remote', 'add', 'origin', 'https://github.com/frankr2994/antigravity-orchestra.git'], fixtureDir);
    await git(['remote', 'set-url', '--push', 'origin', bareDir], fixtureDir);
    await git(['push', '-u', 'origin', 'main'], fixtureDir);

    // 2. Initialize Store and Project/Task
    const store = new Store(dbPath);
    const project = store.upsertProject({ name: 'test-proj', root: fixtureDir, gitRoot: fixtureDir });
    const session = store.createSession(project.id, 'Test Cloud Session');
    const task = store.createTask(project.id, session.id, 'Implement feature on cloud', null, null, 'cloud');
    const expectedHead = (await git(['rev-parse', 'HEAD'], fixtureDir)).stdout.trim();
    const expectedDispatch = generateDispatchBranchName(task.id, expectedHead);

    // 3. Mock Jules API Fetch
    let mockSessionState = 'QUEUED';
    const mockActivities = [
      {
        id: 'act-1',
        name: 'sessions/sess-1234/activities/act-1',
        createTime: '2026-08-22T01:00:00Z',
        originator: 'agent',
        description: 'Analyzing repository code',
      },
    ];

    const mockFetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/sources')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sources: [{ name: 'sources/github/frankr2994/antigravity-orchestra', githubRepo: { owner: 'frankr2994', repo: 'antigravity-orchestra', branches: [{ displayName: 'main' }] } }],
          }),
        };
      }
      if (urlStr.includes('/sources/')) return { ok: true, status: 200, json: async () => ({
        name: 'sources/github/frankr2994/antigravity-orchestra', githubRepo: { owner: 'frankr2994', repo: 'antigravity-orchestra', branches: [{ displayName: 'main' }, { displayName: expectedDispatch }] },
      }) };
      if (urlStr.endsWith('/sessions') && (!opts?.method || opts.method === 'POST')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'sessions/sess-1234',
            id: 'sess-1234',
            state: 'QUEUED',
          }),
        };
      }
      if (urlStr.includes('/sessions/sess-1234/activities')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            activities: mockActivities,
          }),
        };
      }
      if (urlStr.includes('/sessions/sess-1234') && opts?.method === 'DELETE') {
        return { ok: true, status: 204 };
      }
      if (urlStr.includes('/sessions/sess-1234')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'sessions/sess-1234',
            id: 'sess-1234',
            state: mockSessionState,
            outputs: mockSessionState === 'COMPLETED' ? [
              {
                pullRequest: {
                  url: 'https://github.com/frankr2994/antigravity-orchestra/pull/42',
                  title: 'Feature PR',
                },
              },
            ] : undefined,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const julesClient = new JulesApiClient({ apiKey: 'test-api-key', fetchFn: mockFetch });
    const manager = new JulesSessionManager(store);

    // 4. Dispatch Session (with real bare git push)
    const dispatch = await manager.dispatchSession(task.id, task.prompt, {
      projectRoot: fixtureDir,
      julesClient,
    });

    assert.equal(dispatch.ok, true);
    assert.equal(dispatch.cloudSession?.remoteSessionId, 'sess-1234');
    assert.equal(dispatch.attempt?.worker, 'jules');

    // Verify SQLite persistence
    const savedCloud = store.manager.cloudSessions.getByTaskId(task.id);
    assert.equal(savedCloud?.remoteSessionId, 'sess-1234');
    assert.equal(savedCloud?.sourceName, 'sources/github/frankr2994/antigravity-orchestra');
    assert.equal(store.manager.julesSourceMappings.get(project.id)?.startingBranch, expectedDispatch);
    assert.equal(store.manager.managedGitResources.listCleanupDue().length, 0);

    // 5. Poll Session (In-Progress)
    mockSessionState = 'IN_PROGRESS';
    const pollProgress = await manager.pollSession('sess-1234', { julesClient });
    assert.equal(pollProgress.ok, true);
    assert.equal(pollProgress.julesState, 'IN_PROGRESS');
    assert.equal(pollProgress.orchestraState, 'running');
    assert.equal(pollProgress.isTerminal, false);
    assert.equal(pollProgress.newActivitiesCount, 1);

    const pollDuplicate = await manager.pollSession('sess-1234', { julesClient });
    assert.equal(pollDuplicate.newActivitiesCount, 0, 'activity identities must be durable across polls');
    assert.equal(store.manager.julesActivityReceipts.count(savedCloud.id), 1);

    // 6. Poll Session (Completed with PR)
    mockSessionState = 'COMPLETED';
    const pollCompleted = await manager.pollSession('sess-1234', { julesClient });
    assert.equal(pollCompleted.ok, true);
    assert.equal(pollCompleted.julesState, 'COMPLETED');
    assert.equal(pollCompleted.orchestraState, 'reviewing');
    assert.equal(pollCompleted.isTerminal, true);

    const updatedCloud = store.manager.cloudSessions.getByTaskId(task.id);
    assert.equal(updatedCloud?.state, 'COMPLETED');
    assert.equal(updatedCloud?.prUrl, 'https://github.com/frankr2994/antigravity-orchestra/pull/42');

    // 7. Cancel Session
    const cancelResult = await manager.cancelSession('sess-1234', { julesClient });
    assert.equal(cancelResult.ok, true);

    const cancelledCloud = store.manager.cloudSessions.getByTaskId(task.id);
    assert.equal(cancelledCloud?.state, 'CANCELLED');

    const updatedTask = store.getTask(task.id);
    assert.equal(updatedTask?.state, 'cancelled');
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
    try { rmSync(bareDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
