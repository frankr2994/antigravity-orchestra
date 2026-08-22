import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { git } from '../dist-server/git.js';
import { Store } from '../dist-server/db.js';
import { routeTask } from '../dist-server/providers/jules/router.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';

// ============================================================================
// Phase 15 Dynamic Task Routing Policy Engine Test Suite
// ============================================================================

test('Phase 15 Router — Explicit targets are strictly respected', async () => {
  const fixtureDir = join(tmpdir(), `orchestra-rt-exp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    writeFileSync(join(fixtureDir, 'README.md'), '# Explicit Routing Test');
    await git(['add', 'README.md'], fixtureDir);
    await git(['commit', '-m', 'Initial commit'], fixtureDir);

    // 1. Explicit local
    const localRes = await routeTask({
      taskId: 'task-1',
      projectRoot: fixtureDir,
      prompt: 'Refactor database',
      requestedTarget: 'local',
    });
    assert.equal(localRes.target, 'local');
    assert.equal(localRes.worker, 'antigravity');

    // 2. Explicit cloud on repo without remote fails preflight safely
    const cloudFailRes = await routeTask({
      taskId: 'task-2',
      projectRoot: fixtureDir,
      prompt: 'Refactor database',
      requestedTarget: 'cloud',
    });
    assert.equal(cloudFailRes.target, 'cloud');
    assert.equal(cloudFailRes.worker, 'jules');
    assert.equal(cloudFailRes.preflightOk, false);
    assert.ok(cloudFailRes.error);
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 15 Router — Auto-routing decision matrix handles questions, quota, complexity, and fallbacks', async () => {
  const dbPath = join(tmpdir(), `orchestra-rt-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const fixtureDir = join(tmpdir(), `orchestra-rt-auto-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    // Setup git fixture
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    writeFileSync(join(fixtureDir, 'README.md'), '# Auto Routing Test');
    await git(['add', 'README.md'], fixtureDir);
    await git(['commit', '-m', 'Initial commit'], fixtureDir);
    await git(['branch', '-M', 'main'], fixtureDir);
    await git(['remote', 'add', 'origin', 'https://github.com/frankr2994/antigravity-orchestra.git'], fixtureDir);
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], fixtureDir);
    await git(['config', 'branch.main.remote', 'origin'], fixtureDir);
    await git(['config', 'branch.main.merge', 'refs/heads/main'], fixtureDir);

    const store = new Store(dbPath);
    const project = store.upsertProject({ name: 'test-auto', root: fixtureDir, gitRoot: fixtureDir });
    const session = store.createSession(project.id, 'Routing Test');
    const task = store.createTask(project.id, session.id, 'Sample prompt');

    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/sources')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sources: [{ name: 'sources/github/frankr2994/antigravity-orchestra', githubRepo: { owner: 'frankr2994', repo: 'antigravity-orchestra' } }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const julesClient = new JulesApiClient({ apiKey: 'test-api-key', fetchFn: mockFetch });

    // 1. Read-only query -> local
    const qRes = await routeTask({
      taskId: task.id,
      projectRoot: fixtureDir,
      prompt: 'How does authentication work?',
      classification: {
        type: 'question',
        mutating: false,
        complexity: 'small',
        riskFlags: [],
        codexRole: 'none',
        title: 'Auth question',
      },
      requestedTarget: 'auto',
      julesClient,
      store,
    });
    assert.equal(qRes.target, 'local');
    assert.equal(qRes.worker, 'antigravity');

    // 2. Deep complexity refactoring -> cloud
    const deepRes = await routeTask({
      taskId: task.id,
      projectRoot: fixtureDir,
      prompt: 'Refactor whole database layer',
      classification: {
        type: 'implementation',
        mutating: true,
        complexity: 'deep',
        riskFlags: [],
        codexRole: 'design',
        title: 'Deep refactor',
      },
      requestedTarget: 'auto',
      julesClient,
      store,
    });
    assert.equal(deepRes.target, 'cloud');
    assert.equal(deepRes.worker, 'jules');
    assert.equal(deepRes.preflightOk, true);

    // 3. Local quota pressure -> cloud
    const quotaRes = await routeTask({
      taskId: task.id,
      projectRoot: fixtureDir,
      prompt: 'Small fix but local quota exhausted',
      classification: {
        type: 'implementation',
        mutating: true,
        complexity: 'small',
        riskFlags: [],
        codexRole: 'none',
        title: 'Small fix',
      },
      requestedTarget: 'auto',
      localQuotaExhausted: true,
      julesClient,
      store,
    });
    assert.equal(quotaRes.target, 'cloud');
    assert.equal(quotaRes.worker, 'jules');

    // 4. Standard mutating task -> local interactive
    const normalRes = await routeTask({
      taskId: task.id,
      projectRoot: fixtureDir,
      prompt: 'Add a helper function',
      classification: {
        type: 'implementation',
        mutating: true,
        complexity: 'normal',
        riskFlags: [],
        codexRole: 'none',
        title: 'Add helper',
      },
      requestedTarget: 'auto',
      julesClient,
      store,
    });
    assert.equal(normalRes.target, 'local');
    assert.equal(normalRes.worker, 'antigravity');

    // Verify task events logged
    const events = store.listEvents(task.id);
    const routedEvents = events.filter((e) => e.type === 'task.routed');
    assert.ok(routedEvents.length >= 4);

    store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
