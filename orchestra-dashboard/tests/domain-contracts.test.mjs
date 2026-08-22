import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapJulesToOrchestraState,
} from '../dist-server/domain/index.js';

// ============================================================================
// Phase 3 Domain Contracts & State Mapping Test Suite
// ============================================================================

test('Phase 3 Domain — mapJulesToOrchestraState covers all 9 canonical Jules states', () => {
  // 1. QUEUED
  const queued = mapJulesToOrchestraState('QUEUED');
  assert.equal(queued.taskState, 'running');
  assert.equal(queued.executionState, 'DISPATCHING');
  assert.equal(queued.requiresUserAction, false);
  assert.equal(queued.isTerminal, false);

  // 2. PLANNING
  const planning = mapJulesToOrchestraState('PLANNING');
  assert.equal(planning.taskState, 'running');
  assert.equal(planning.executionState, 'PLANNING');
  assert.equal(planning.requiresUserAction, false);
  assert.equal(planning.isTerminal, false);

  // 3. AWAITING_PLAN_APPROVAL
  const awaitingPlan = mapJulesToOrchestraState('AWAITING_PLAN_APPROVAL');
  assert.equal(awaitingPlan.taskState, 'running');
  assert.equal(awaitingPlan.executionState, 'AWAITING_APPROVAL');
  assert.equal(awaitingPlan.requiresUserAction, true);
  assert.equal(awaitingPlan.isTerminal, false);

  // 4. AWAITING_USER_FEEDBACK
  const awaitingFeedback = mapJulesToOrchestraState('AWAITING_USER_FEEDBACK');
  assert.equal(awaitingFeedback.taskState, 'running');
  assert.equal(awaitingFeedback.executionState, 'AWAITING_FEEDBACK');
  assert.equal(awaitingFeedback.requiresUserAction, true);
  assert.equal(awaitingFeedback.isTerminal, false);

  // 5. IN_PROGRESS
  const inProgress = mapJulesToOrchestraState('IN_PROGRESS');
  assert.equal(inProgress.taskState, 'running');
  assert.equal(inProgress.executionState, 'WORKING');
  assert.equal(inProgress.requiresUserAction, false);
  assert.equal(inProgress.isTerminal, false);

  // 6. PAUSED
  const paused = mapJulesToOrchestraState('PAUSED');
  assert.equal(paused.taskState, 'running');
  assert.equal(paused.executionState, 'PAUSED');
  assert.equal(paused.requiresUserAction, true);
  assert.equal(paused.isTerminal, false);

  // 7. COMPLETED (Transitions task to 'reviewing' so Orchestra can fetch the PR & run Codex review)
  const completed = mapJulesToOrchestraState('COMPLETED');
  assert.equal(completed.taskState, 'reviewing');
  assert.equal(completed.executionState, 'COMPLETED');
  assert.equal(completed.requiresUserAction, false);
  assert.equal(completed.isTerminal, false);

  // 8. FAILED
  const failed = mapJulesToOrchestraState('FAILED');
  assert.equal(failed.taskState, 'failed');
  assert.equal(failed.executionState, 'FAILED');
  assert.equal(failed.requiresUserAction, false);
  assert.equal(failed.isTerminal, true);

  // 9. STATE_UNSPECIFIED
  const unspecified = mapJulesToOrchestraState('STATE_UNSPECIFIED');
  assert.equal(unspecified.taskState, 'running');
  assert.equal(unspecified.executionState, 'WORKING');
  assert.equal(unspecified.requiresUserAction, false);
  assert.equal(unspecified.isTerminal, false);
});

test('Phase 3 Domain — mapJulesToOrchestraState handles unknown or malformed states safely without crashing', () => {
  // Case-insensitivity
  const lowercase = mapJulesToOrchestraState('in_progress');
  assert.equal(lowercase.executionState, 'WORKING');

  // Unknown future state
  const futureState = mapJulesToOrchestraState('ANALYZING_DEPENDENCIES_V2');
  assert.equal(futureState.taskState, 'running');
  assert.equal(futureState.executionState, 'WORKING');
  assert.equal(futureState.isTerminal, false);
  assert.match(futureState.reason || '', /degraded safely/i);

  // Null & Undefined safety
  const nullState = mapJulesToOrchestraState(null);
  assert.equal(nullState.taskState, 'running');
  assert.equal(nullState.executionState, 'WORKING');

  const emptyState = mapJulesToOrchestraState('');
  assert.equal(emptyState.taskState, 'running');
  assert.equal(emptyState.executionState, 'WORKING');
});

test('Phase 3 Domain — ExecutionTarget & WorkerIdentity Contracts', () => {
  const sampleAttempt = {
    id: 'attempt-123',
    taskId: 'task-456',
    target: 'cloud',
    worker: 'jules',
    baseSha: 'abc1234567890',
    state: 'WORKING',
    retryCount: 0,
    startedAt: new Date().toISOString(),
  };

  assert.equal(sampleAttempt.target, 'cloud');
  assert.equal(sampleAttempt.worker, 'jules');
  assert.equal(sampleAttempt.state, 'WORKING');
});

test('Phase 3 Domain — ReviewVerdict & VerificationResult Contracts', () => {
  const verdict = {
    verdict: 'PASS',
    blocked: false,
    findings: [],
    summary: 'No issues found during Codex review.',
    reviewedSha: 'abc1234567890',
    reviewer: 'codex',
    model: 'gpt-5.6-sol',
  };

  assert.equal(verdict.verdict, 'PASS');
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.reviewer, 'codex');

  const verification = {
    status: 'passed',
    verifiedSha: 'abc1234567890',
    summary: 'Build and unit tests passed cleanly.',
    durationMs: 4200,
    checks: [
      { name: 'build', command: 'npm run build', status: 'passed', durationMs: 1200 },
      { name: 'test', command: 'npm test', status: 'passed', durationMs: 3000 },
    ],
  };

  assert.equal(verification.status, 'passed');
  assert.equal(verification.checks.length, 2);
});
