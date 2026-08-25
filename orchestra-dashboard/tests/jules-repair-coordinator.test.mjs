import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { Store } from '../dist-server/db.js';
import {
  evaluateRepairStrategy,
  formatRepairFeedbackPrompt,
  executeDualEngineRepair,
} from '../dist-server/providers/jules/repair-coordinator.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';

// ============================================================================
// Phase 13 Dual-Engine Local/Cloud Repair Loop Test Suite
// ============================================================================

test('Phase 13 Repair Loop — active Jules sessions keep receiving feedback without a repair ceiling', () => {
  const dummyFindings = [{ severity: 'blocking', explanation: 'Null pointer bug' }];

  for (const cycle of [1, 3, 20]) {
    const decision = evaluateRepairStrategy({
      cycle,
      isCloudSessionActive: true,
      findings: dummyFindings,
    });
    assert.equal(decision.strategy, 'cloud_feedback');
    assert.equal(decision.cycle, cycle);
  }

  const inactive = evaluateRepairStrategy({
    cycle: 21,
    isCloudSessionActive: false,
    findings: dummyFindings,
  });
  assert.equal(inactive.strategy, 'local_takeover');
  assert.equal(inactive.cycle, 21);
});

test('Phase 13 Repair Loop — formatRepairFeedbackPrompt includes findings and verification errors', () => {
  const prompt = formatRepairFeedbackPrompt(
    [
      { severity: 'blocking', file: 'src/index.ts', line: 10, explanation: 'Missing export declaration' },
    ],
    [
      { command: 'npm test', code: 1, output: 'SyntaxError in src/index.ts with AIzaSySecretToken' },
    ]
  );

  assert.ok(prompt.includes('Required Fixes:'));
  assert.ok(prompt.includes('[BLOCKING] (src/index.ts:10): Missing export declaration'));
  assert.ok(prompt.includes('Verification Failures:'));
  assert.ok(prompt.includes('Command: `npm test` exited with code 1'));
  assert.ok(!prompt.includes('AIzaSySecretToken'));
});

test('Phase 13 Repair Loop — executeDualEngineRepair keeps Jules working at high cycles and takes over only when unavailable', async () => {
  const dbPath = join(tmpdir(), `orchestra-rc-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const fixtureDir = join(tmpdir(), `orchestra-rc-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    const store = new Store(dbPath);
    const project = store.upsertProject({ name: 'test-rc', root: fixtureDir, gitRoot: fixtureDir });
    const session = store.createSession(project.id, 'Repair Test Session');
    const task = store.createTask(project.id, session.id, 'Repair cloud PR task', null, null, 'cloud');

    // Create initial cloud session in DB
    const cloudSession = store.manager.cloudSessions.create({
      taskId: task.id,
      sourceName: 'sources/github/frankr2994/antigravity-orchestra',
      sessionResourceName: 'sessions/sess-rep-1',
      remoteSessionId: 'sess-rep-1',
      dispatchBranch: 'orchestra/jules-base/task-1-sha',
      targetBranch: 'main',
      baseSha: 'base-sha-123',
      state: 'IN_PROGRESS',
    });

    let feedbackCount = 0;
    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('sendMessage') || urlStr.includes('sendFeedback')) {
        feedbackCount += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const julesClient = new JulesApiClient({ apiKey: 'test-key', fetchFn: mockFetch });

    // 1. Cycle 1: Cloud Feedback
    const cloudRepairRes = await executeDualEngineRepair({
      taskId: task.id,
      projectRoot: fixtureDir,
      remoteSessionId: cloudSession.remoteSessionId,
      baseSha: 'base-sha-123',
      headSha: 'head-sha-456',
      findings: [{ severity: 'blocking', explanation: 'Fix typo in return object' }],
      cycle: 1,
      store,
      julesClient,
    });

    assert.equal(cloudRepairRes.strategy, 'cloud_feedback');
    assert.equal(cloudRepairRes.ok, true);
    assert.equal(feedbackCount, 1);

    const attemptsAfter1 = store.manager.attempts.listByTaskId(task.id);
    assert.equal(attemptsAfter1.length, 1);
    assert.equal(attemptsAfter1[0].target, 'cloud');
    assert.equal(attemptsAfter1[0].worker, 'jules');

    // 2. Cycle 20: Jules still receives feedback. The cycle number is telemetry,
    // not a stop condition.
    const highCycleRes = await executeDualEngineRepair({
      taskId: task.id,
      projectRoot: fixtureDir,
      remoteSessionId: cloudSession.remoteSessionId,
      baseSha: 'base-sha-123',
      headSha: 'head-sha-456',
      findings: [{ severity: 'blocking', explanation: 'Persistent issue still needs repair' }],
      cycle: 20,
      store,
      julesClient,
    });

    assert.equal(highCycleRes.strategy, 'cloud_feedback');
    assert.equal(highCycleRes.ok, true);
    assert.equal(highCycleRes.cycle, 20);
    assert.equal(feedbackCount, 2);
    assert.equal(store.manager.attempts.listByTaskId(task.id).length, 2);

    // 3. Jules becomes unavailable: request a local takeover. The review service must first
    // import the exact PR head before it queues a real local attempt.
    store.manager.cloudSessions.update(cloudSession.id, { state: 'FAILED' });
    const takeoverRes = await executeDualEngineRepair({
      taskId: task.id,
      projectRoot: fixtureDir,
      remoteSessionId: cloudSession.remoteSessionId,
      baseSha: 'base-sha-123',
      headSha: 'head-sha-456',
      findings: [{ severity: 'blocking', explanation: 'Continue locally' }],
      cycle: 21,
      store,
      julesClient,
    });

    assert.equal(takeoverRes.strategy, 'local_takeover');
    assert.equal(takeoverRes.ok, true);
    assert.equal(takeoverRes.cycle, 21);
    assert.equal(store.manager.attempts.listByTaskId(task.id).length, 2);
    assert.equal(store.listEvents(task.id).at(-1)?.type, 'task.takeover_local');
    assert.notEqual(store.getTask(task.id)?.state, 'review_disputed');

    store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
