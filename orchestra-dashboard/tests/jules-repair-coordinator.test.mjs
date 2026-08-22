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

test('Phase 13 Repair Loop — evaluateRepairStrategy selects appropriate strategy based on cycle and state', () => {
  const dummyFindings = [{ severity: 'blocking', explanation: 'Null pointer bug' }];

  // Cycle 1: active cloud -> cloud_feedback
  const dec1 = evaluateRepairStrategy({
    cycle: 1,
    maxCycles: 3,
    maxCloudAttempts: 2,
    isCloudSessionActive: true,
    findings: dummyFindings,
  });
  assert.equal(dec1.strategy, 'cloud_feedback');

  // Cycle 2: active cloud -> cloud_feedback
  const dec2 = evaluateRepairStrategy({
    cycle: 2,
    maxCycles: 3,
    maxCloudAttempts: 2,
    isCloudSessionActive: true,
    findings: dummyFindings,
  });
  assert.equal(dec2.strategy, 'cloud_feedback');

  // Cycle 3: cloud exhausted -> local_takeover
  const dec3 = evaluateRepairStrategy({
    cycle: 3,
    maxCycles: 3,
    maxCloudAttempts: 2,
    isCloudSessionActive: true,
    findings: dummyFindings,
  });
  assert.equal(dec3.strategy, 'local_takeover');

  // Cycle 1 but cloud inactive -> local_takeover
  const decInactive = evaluateRepairStrategy({
    cycle: 1,
    maxCycles: 3,
    maxCloudAttempts: 2,
    isCloudSessionActive: false,
    findings: dummyFindings,
  });
  assert.equal(decInactive.strategy, 'local_takeover');

  // Cycle 4 (> maxCycles) -> escalate_dispute
  const decDispute = evaluateRepairStrategy({
    cycle: 4,
    maxCycles: 3,
    maxCloudAttempts: 2,
    isCloudSessionActive: true,
    findings: dummyFindings,
  });
  assert.equal(decDispute.strategy, 'escalate_dispute');
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

test('Phase 13 Repair Loop — executeDualEngineRepair orchestrates cloud repair and local takeover', async () => {
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

    let feedbackSent = false;
    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('sendFeedback')) {
        feedbackSent = true;
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
    assert.equal(feedbackSent, true);

    const attemptsAfter1 = store.manager.attempts.listByTaskId(task.id);
    assert.equal(attemptsAfter1.length, 1);
    assert.equal(attemptsAfter1[0].target, 'cloud');
    assert.equal(attemptsAfter1[0].worker, 'jules');

    // 2. Cycle 3: Local Takeover
    const takeoverRes = await executeDualEngineRepair({
      taskId: task.id,
      projectRoot: fixtureDir,
      remoteSessionId: cloudSession.remoteSessionId,
      baseSha: 'base-sha-123',
      headSha: 'head-sha-456',
      findings: [{ severity: 'blocking', explanation: 'Complex fix requiring local environment' }],
      cycle: 3,
      store,
      julesClient,
    });

    assert.equal(takeoverRes.strategy, 'local_takeover');
    assert.equal(takeoverRes.ok, true);

    // listByTaskId returns newest first
    const attemptsAfter2 = store.manager.attempts.listByTaskId(task.id);
    assert.equal(attemptsAfter2.length, 2);
    assert.equal(attemptsAfter2[0].target, 'local');
    assert.equal(attemptsAfter2[0].worker, 'antigravity');
    assert.equal(attemptsAfter2[1].target, 'cloud');
    assert.equal(attemptsAfter2[1].worker, 'jules');

    const updatedTask = store.getTask(task.id);
    assert.equal(updatedTask?.target, 'local');

    // 3. Cycle 4: Dispute Escalation
    const disputeRes = await executeDualEngineRepair({
      taskId: task.id,
      projectRoot: fixtureDir,
      remoteSessionId: cloudSession.remoteSessionId,
      baseSha: 'base-sha-123',
      headSha: 'head-sha-456',
      findings: [{ severity: 'blocking', explanation: 'Persistent deadlock' }],
      cycle: 4,
      store,
      julesClient,
    });

    assert.equal(disputeRes.strategy, 'escalate_dispute');
    assert.equal(disputeRes.ok, false);

    const disputedTask = store.getTask(task.id);
    assert.equal(disputedTask?.state, 'review_disputed');

    store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
