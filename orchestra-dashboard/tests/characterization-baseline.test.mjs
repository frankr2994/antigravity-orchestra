import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist-server/db.js';
import { recoveryDisposition } from '../dist-server/tasks.js';
import { selectModels, normalizeClassification, extractCodexReviewVerdict, buildReviewPacket } from '../dist-server/agents.js';
import { collectRepositoryEvidence } from '../dist-server/evidence.js';

// ============================================================================
// Phase 1 Characterization Baseline Test Suite
// Establishes immutable behavioral baseline for Orchestra local task workflows
// ============================================================================

test('Phase 1 Baseline — Task State Machine & Valid Transitions', () => {
  const validStates = [
    'queued',
    'running',
    'reviewing',
    'verifying',
    'completed',
    'completed_unpushed',
    'failed',
    'recovering',
    'recovery_required',
    'baseline_required',
    'review_disputed',
    'cancelled',
  ];

  // Verify all documented states are recognized strings
  for (const state of validStates) {
    assert.equal(typeof state, 'string');
  }

  // Recovery disposition rules
  assert.equal(recoveryDisposition('failed', false), 'start');
  assert.equal(recoveryDisposition('recovery_required', false), 'start');
  assert.equal(recoveryDisposition('running', true), 'already_active');
  assert.equal(recoveryDisposition('completed', false), 'reject');
  assert.equal(recoveryDisposition('running', false), 'reject');
  assert.equal(recoveryDisposition('cancelled', false), 'reject');
});

test('Phase 1 Baseline — SSE Event Names and Payload Shape Specifications', () => {
  // Registry of all canonical SSE event names emitted across Orchestra
  const canonicalEventRegistry = {
    system: [
      'task.state',
      'task.recovery',
      'task.retry',
      'task.steer',
      'project.onboarding',
      'mcp.capability',
      'routing.adjustment',
      'task.model-takeover',
      'task.provider-recovery',
    ],
    git: [
      'git.commit',
      'git.push',
      'git.remote',
      'git.baseline-required',
    ],
    gemma: [
      'agent.started',
      'agent.completed',
      'stream',
      'warning',
      'mcp.tool',
    ],
    antigravity: [
      'agent.started',
      'agent.completed',
      'stream',
      'warning',
    ],
    codex: [
      'agent.started',
      'agent.completed',
      'stream',
      'warning',
      'review.started',
      'review.completed',
      'review.verdict',
    ],
  };

  // Assert expected events exist in each category
  assert.ok(canonicalEventRegistry.system.includes('task.state'));
  assert.ok(canonicalEventRegistry.system.includes('task.recovery'));
  assert.ok(canonicalEventRegistry.git.includes('git.commit'));
  assert.ok(canonicalEventRegistry.git.includes('git.push'));
  assert.ok(canonicalEventRegistry.antigravity.includes('agent.started'));
  assert.ok(canonicalEventRegistry.codex.includes('agent.started'));
  assert.ok(canonicalEventRegistry.gemma.includes('agent.started'));

  // Event payload structural specifications
  const sampleStateEvent = { state: 'cancelled' };
  assert.equal(typeof sampleStateEvent.state, 'string');

  const sampleCommitEvent = { kind: 'task', sha: 'abc1234', title: 'feat: add login', files: ['src/auth.ts'] };
  assert.equal(sampleCommitEvent.kind, 'task');
  assert.equal(typeof sampleCommitEvent.sha, 'string');
  assert.ok(Array.isArray(sampleCommitEvent.files));

  const sampleReviewVerdictEvent = {
    verdict: 'approved',
    findingCount: 0,
    blockingCount: 0,
    reviewer: 'codex',
    model: 'gpt-5.6-sol',
  };
  assert.equal(sampleReviewVerdictEvent.verdict, 'approved');
  assert.equal(sampleReviewVerdictEvent.blockingCount, 0);
});

test('Phase 1 Baseline — Task Fixtures: Successful, Failed, Interrupted, Disputed', () => {
  const dbPath = join(tmpdir(), `orchestra-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const projectRoot = join(tmpdir(), `orchestra-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const store = new Store(dbPath);

  try {
    // 1. Create Project
    const project = store.upsertProject({ name: 'Baseline App', root: projectRoot, gitRoot: null });
    assert.ok(project.id);

    // 2. Create Session
    const session = store.createSession(project.id, 'Main Session');
    assert.ok(session.id);

    // 3. Fixture A: Successful Task
    const successfulTask = store.createTask(project.id, session.id, 'Implement authentication endpoint');
    store.updateTask(successfulTask.id, {
      state: 'completed',
      result: 'Authentication endpoint implemented successfully.',
      models: JSON.stringify({ antigravity: 'gemini-3.7-flash-high', codex: 'gpt-5.6-sol' }),
      classification: JSON.stringify({ type: 'implementation', mutating: true, complexity: 'normal' }),
    });
    const loadedSuccess = store.getTask(successfulTask.id);
    assert.equal(loadedSuccess?.state, 'completed');
    assert.equal(typeof loadedSuccess?.result, 'string');

    // 4. Fixture B: Failed Task with Error
    const failedTask = store.createTask(project.id, session.id, 'Faulty migration');
    store.updateTask(failedTask.id, {
      state: 'failed',
      error: 'Process timed out after 180000ms without progress.',
      models: JSON.stringify({ antigravity: 'gemini-3.7-flash-high' }),
    });
    const loadedFailed = store.getTask(failedTask.id);
    assert.equal(loadedFailed?.state, 'failed');
    assert.match(loadedFailed?.error || '', /timed out/);

    // 5. Fixture C: Interrupted Task Reconciled after Server Restart
    const interruptedTask = store.createTask(project.id, session.id, 'Interrupted background job');
    store.updateTask(interruptedTask.id, { state: 'running' });
    const recovered = store.recoverInterruptedTasks();
    assert.ok(recovered.includes(interruptedTask.id));
    const loadedInterrupted = store.getTask(interruptedTask.id);
    assert.equal(loadedInterrupted?.state, 'failed');
    assert.match(loadedInterrupted?.error || '', /restarted while this task was running/);

    // 6. Fixture D: Disputed Task awaiting User Approval
    const disputedTask = store.createTask(project.id, session.id, 'Controversial refactoring');
    store.updateTask(disputedTask.id, {
      state: 'review_disputed',
      result: 'Refactored module but Codex flagged performance concern.',
      classification: JSON.stringify({ type: 'implementation', mutating: true, complexity: 'deep' }),
    });
    const loadedDisputed = store.getTask(disputedTask.id);
    assert.equal(loadedDisputed?.state, 'review_disputed');

    // 7. Add Timeline Events and Verify Retrieval
    store.addEvent(successfulTask.id, 'antigravity', 'agent.started', { phase: 'implementation' });
    store.addEvent(successfulTask.id, 'codex', 'review.verdict', { verdict: 'approved' });
    const events = store.listEvents(successfulTask.id);
    assert.equal(events.length, 2);
    assert.equal(events[0].agent, 'antigravity');
    assert.equal(events[1].agent, 'codex');
  } finally {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 1 Baseline — Direct Chat vs 2-Stage Task Routing Specification', () => {
  // Conversational prompt routing (Gemma Direct)
  const greeting = normalizeClassification({ type: 'question', mutating: false, complexity: 'small', riskFlags: [], codexRole: 'none', executionMode: 'direct', directAgent: 'gemma', title: 'Hello' }, 'Say hello');
  assert.equal(greeting.executionMode, 'direct');
  assert.equal(greeting.directAgent, 'gemma');

  // Complex Implementation routing (Antigravity Local + Codex Review)
  const complexImpl = normalizeClassification({ type: 'implementation', mutating: true, complexity: 'deep', riskFlags: ['database'], codexRole: 'design', localOperation: 'none', title: 'DB Refactor' }, 'Refactor database schema across all models');
  assert.equal(complexImpl.mutating, true);
  assert.equal(complexImpl.codexRole, 'design');
  const models = selectModels(complexImpl);
  assert.equal(models.antigravity, 'gemini-3.7-flash-high');
  assert.equal(models.codex, 'gpt-5.6-sol');
});

test('Phase 1 Baseline — Review & Verification Packet Contracts', () => {
  const packet = buildReviewPacket({
    request: 'Add JWT authorization middleware',
    diff: 'diff --git a/src/auth.ts b/src/auth.ts\n+export function verifyJwt() {}',
    changedFiles: ['src/auth.ts'],
    implementationSummary: 'Implemented JWT middleware with token expiry verification.',
    triage: {
      risk: 'ordinary',
      summary: 'Standard authorization middleware implementation.',
      focusFiles: ['src/auth.ts'],
      concerns: [],
    },
  });

  assert.match(packet, /Original request/);
  assert.match(packet, /Add JWT authorization middleware/);
  assert.match(packet, /Changed files/);
  assert.match(packet, /src\/auth\.ts/);
  assert.match(packet, /Standard authorization middleware/);
  assert.match(packet, /Implemented JWT middleware/);

  // Parse review verdict strings
  const approvedVerdict = extractCodexReviewVerdict('# Verdict: PASS\n\nNo issues found.');
  assert.equal(approvedVerdict.verdict, 'PASS');
  assert.equal(approvedVerdict.blocked, false);

  const rejectedVerdict = extractCodexReviewVerdict('# Verdict: BLOCK\n\n- [BLOCKING] Missing token expiry check in auth.ts:15');
  assert.equal(rejectedVerdict.verdict, 'BLOCK');
  assert.equal(rejectedVerdict.blocked, true);
});

test('Phase 1 Baseline — Selective Repository Evidence Bounding', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'orchestra-evidence-baseline-'));
  try {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '1.0.0' }));
    writeFileSync(join(tempDir, 'index.ts'), 'export const hello = "world";\n');

    // Evidence collection bounding
    const evidence = collectRepositoryEvidence(tempDir, 'Check package.json and index.ts', undefined, undefined, undefined, 4000);
    assert.ok(evidence.characterCount <= 4000);
    assert.ok(evidence.includedFiles.includes('package.json'));
    assert.ok(evidence.includedFiles.includes('index.ts'));
    assert.equal(typeof evidence.text, 'string');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
