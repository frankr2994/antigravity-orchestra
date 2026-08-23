import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_STATE_TRANSITIONS,
  isValidTaskStateTransition,
  isTerminalTaskState,
  isOrchestraTaskState,
  validateReviewVerdict,
} from '../dist-server/domain/index.js';
import {
  mapJulesToOrchestraState,
  isJulesTerminalState,
} from '../dist-server/providers/jules/index.js';
import { TaskEventRepository } from '../dist-server/infrastructure/database/repositories/events.js';
import { TaskRepository } from '../dist-server/infrastructure/database/repositories/tasks.js';
import { redactSecretsDeep } from '../dist-server/infrastructure/security/redaction.js';
import { DatabaseSync } from 'node:sqlite';

// ============================================================================
// Stage A Authoritative Domain & Wire Contract Conformance Proving Suite
// ============================================================================

test('Stage A Contracts — Task State Transitions matrix and invariants', () => {
  // 1. Terminal states cannot transition to anything
  assert.equal(isTerminalTaskState('completed'), true);
  assert.equal(isTerminalTaskState('cancelled'), true);
  assert.equal(isTerminalTaskState('running'), false);
  assert.deepEqual(TASK_STATE_TRANSITIONS.completed, []);
  assert.deepEqual(TASK_STATE_TRANSITIONS.cancelled, []);

  // 2. Valid transitions
  assert.equal(isValidTaskStateTransition('queued', 'running'), true);
  assert.equal(isValidTaskStateTransition('running', 'reviewing'), true);
  assert.equal(isValidTaskStateTransition('reviewing', 'verifying'), true);
  assert.equal(isValidTaskStateTransition('running', 'failed'), true);
  assert.equal(isValidTaskStateTransition('failed', 'queued'), true); // Retry
  assert.equal(isValidTaskStateTransition('failed', 'recovering'), true); // Automated repair resume
  assert.equal(isValidTaskStateTransition('failed', 'recovery_required'), true);
  assert.equal(isValidTaskStateTransition('preflight', 'reviewing'), true);
  assert.equal(isValidTaskStateTransition('reviewing', 'running'), true);
  assert.equal(isValidTaskStateTransition('baseline_required', 'queued'), true);
  assert.equal(isValidTaskStateTransition('review_disputed', 'summarizing'), true);

  // 3. Prohibited invalid transitions (negative tests)
  assert.equal(isValidTaskStateTransition('completed', 'running'), false);
  assert.equal(isValidTaskStateTransition('completed', 'queued'), false);
  assert.equal(isValidTaskStateTransition('completed', 'completed'), false); // Terminal cannot self-transition
  assert.equal(isValidTaskStateTransition('cancelled', 'cancelled'), false); // Terminal cannot self-transition
  assert.equal(isValidTaskStateTransition('cancelled', 'running'), false);
  assert.equal(isValidTaskStateTransition('queued', 'completed'), false);
});

test('Stage A Contracts — validateReviewVerdict strictly enforces consistency and prevents false PASS with blockers', () => {
  // 1. Valid passing verdict
  const passVerdict = {
    verdict: 'PASS',
    blocked: false,
    findings: [],
    summary: 'All tests pass cleanly',
    reviewer: 'codex',
    model: 'gpt-5-codex',
  };
  assert.equal(validateReviewVerdict(passVerdict).valid, true);

  // 2. Valid blocking verdict
  const blockVerdict = {
    verdict: 'BLOCK',
    blocked: true,
    findings: [{ severity: 'blocking', explanation: 'Memory leak' }],
    summary: 'Blocking finding detected',
    reviewer: 'codex',
    model: 'gpt-5-codex',
  };
  assert.equal(validateReviewVerdict(blockVerdict).valid, true);

  // 3. Contradictory: PASS with blocking findings (must fail whether blocked is true or false)
  const passWithBlocker1 = {
    verdict: 'PASS',
    blocked: false,
    findings: [{ severity: 'blocking', explanation: 'Critical SQL injection' }],
    summary: 'Contradictory',
    reviewer: 'codex',
    model: 'gpt-5-codex',
  };
  assert.equal(validateReviewVerdict(passWithBlocker1).valid, false);

  const passWithBlocker2 = {
    verdict: 'PASS',
    blocked: true,
    findings: [{ severity: 'blocking', explanation: 'Critical SQL injection' }],
    summary: 'Contradictory',
    reviewer: 'codex',
    model: 'gpt-5-codex',
  };
  assert.equal(validateReviewVerdict(passWithBlocker2).valid, false);

  // 4. Contradictory: BLOCK without blocking findings
  const blockWithoutBlockers = {
    verdict: 'BLOCK',
    blocked: true,
    findings: [{ severity: 'warning', explanation: 'Minor lint style' }],
    summary: 'Contradictory',
    reviewer: 'codex',
    model: 'gpt-5-codex',
  };
  assert.equal(validateReviewVerdict(blockWithoutBlockers).valid, false);

  // 5. Contradictory: BLOCK with blocked=false
  const blockWithBlockedFalse = {
    verdict: 'BLOCK',
    blocked: false,
    findings: [{ severity: 'blocking', explanation: 'Deadlock risk' }],
    summary: 'Contradictory',
    reviewer: 'codex',
    model: 'gpt-5-codex',
  };
  assert.equal(validateReviewVerdict(blockWithBlockedFalse).valid, false);
});

test('Stage A Contracts — mapJulesToOrchestraState maps all canonical Jules states cleanly and reports terminal status accurately', () => {
  const cases = [
    { jules: 'QUEUED', expectedTask: 'running', expectedExec: 'DISPATCHING', isProviderTerminal: false, isTaskTerminal: false },
    { jules: 'PLANNING', expectedTask: 'running', expectedExec: 'PLANNING', isProviderTerminal: false, isTaskTerminal: false },
    { jules: 'AWAITING_PLAN_APPROVAL', expectedTask: 'running', expectedExec: 'AWAITING_APPROVAL', isProviderTerminal: false, isTaskTerminal: false },
    { jules: 'AWAITING_USER_FEEDBACK', expectedTask: 'running', expectedExec: 'AWAITING_FEEDBACK', isProviderTerminal: false, isTaskTerminal: false },
    { jules: 'IN_PROGRESS', expectedTask: 'running', expectedExec: 'WORKING', isProviderTerminal: false, isTaskTerminal: false },
    { jules: 'PAUSED', expectedTask: 'running', expectedExec: 'PAUSED', isProviderTerminal: false, isTaskTerminal: false },
    { jules: 'COMPLETED', expectedTask: 'reviewing', expectedExec: 'COMPLETED', isProviderTerminal: true, isTaskTerminal: false },
    { jules: 'FAILED', expectedTask: 'failed', expectedExec: 'FAILED', isProviderTerminal: true, isTaskTerminal: false },
  ];

  for (const c of cases) {
    const res = mapJulesToOrchestraState(c.jules);
    assert.equal(res.taskState, c.expectedTask, `Failed taskState for ${c.jules}`);
    assert.equal(res.executionState, c.expectedExec, `Failed execState for ${c.jules}`);
    assert.equal(res.isProviderTerminal, c.isProviderTerminal, `Failed isProviderTerminal for ${c.jules}`);
    assert.equal(res.isTaskTerminal, c.isTaskTerminal, `Failed isTaskTerminal for ${c.jules}`);
    assert.equal(isJulesTerminalState(c.jules), c.isProviderTerminal, `Failed terminal for ${c.jules}`);
  }

  // Unknown states
  const unknownRes = mapJulesToOrchestraState('FUTURE_ALPHA_STATE');
  assert.equal(unknownRes.executionState, 'UNKNOWN');
  assert.equal(unknownRes.uncertain, true);
  assert.equal(unknownRes.taskState, 'running');
});

test('Stage A Contracts — TaskRepository enforces state transitions and enum validation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'local',
      classification TEXT,
      models TEXT,
      result TEXT,
      error TEXT,
      commit_sha TEXT,
      push_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const repo = new TaskRepository(db);
  const task = repo.create('proj-1', 'sess-1', 'Test task');
  assert.equal(task.state, 'queued');

  // Legal transition queued -> running
  repo.update(task.id, { state: 'running' });
  const updated = repo.getById(task.id);
  assert.equal(updated?.state, 'running');

  // Illegal transition running -> queued (must throw)
  assert.throws(
    () => repo.update(task.id, { state: 'queued' }),
    /Illegal task state transition/i
  );

  // Invalid enum (must throw)
  assert.throws(
    () => repo.update(task.id, { state: 'NON_EXISTENT_STATE' }),
    /Invalid task state/i
  );

  db.prepare('UPDATE tasks SET state=? WHERE id=?').run('CORRUPT_STATE', task.id);
  assert.throws(() => repo.getById(task.id), /Persisted task contains invalid state/);
});

test('Stage A Contracts — TaskEventRepository deeply sanitizes secrets at persistence boundary', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const repo = new TaskEventRepository(db);
  const event = repo.add('task-1', 'jules', 'cloud.feedback_sent', {
    message: 'User prompt with key AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz and token ghp_secret1234567890abcdef',
    details: {
      url: 'https://user:secretpass@github.com/repo.git',
      auth: 'sk-proj-supersecret12345',
    },
  });

  // Verify memory object has redacted secrets
  const msg = event.payload.message;
  assert.ok(!msg.includes('AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz'));
  assert.ok(!msg.includes('ghp_secret1234567890abcdef'));
  assert.ok(msg.includes('[REDACTED_API_KEY]'));
  assert.ok(msg.includes('[REDACTED_GH_TOKEN]'));

  assert.equal(event.payload.details.url, 'https://user:[REDACTED_PASSWORD]@github.com/repo.git');
  assert.equal(event.payload.details.auth, '[REDACTED_KEY]');

  // Verify database persisted row is also redacted
  const list = repo.list('task-1');
  assert.equal(list.length, 1);
  assert.equal(list[0].payload.details.auth, '[REDACTED_KEY]');
});

test('Stage A Contracts — isOrchestraTaskState and redactSecretsDeep unit validation', () => {
  assert.equal(isOrchestraTaskState('queued'), true);
  assert.equal(isOrchestraTaskState('running'), true);
  assert.equal(isOrchestraTaskState('completed'), true);
  assert.equal(isOrchestraTaskState('invalid_state'), false);

  const raw = { password: 'secretpassword', token: 'Bearer ya29.abcdef123456789' };
  const sanitized = redactSecretsDeep(raw);
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.token, '[REDACTED]');

  const nestedError = new Error('request failed with apiKey=AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz', {
    cause: new Error('Authorization: Bearer hidden-value'),
  });
  const safeError = redactSecretsDeep(nestedError);
  assert.equal(JSON.stringify(safeError).includes('AIzaSy'), false);
  assert.equal(JSON.stringify(safeError).includes('hidden-value'), false);
});

test('Stage A Contracts — invalid events are rejected before persistence and on historical reads', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const repo = new TaskEventRepository(db);
  assert.throws(() => repo.add('task-1', 'arbitrary-agent', 'warning', { message: 'bad' }), /Unknown task event agent/);
  assert.throws(() => repo.add('task-1', 'system', 'arbitrary.event', {}), /Unknown task event type/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events').get().count, 0);

  db.prepare('INSERT INTO task_events (task_id,agent,type,payload,created_at) VALUES (?,?,?,?,?)').run(
    'task-1', 'system', 'arbitrary.event', '{}', new Date().toISOString(),
  );
  assert.throws(() => repo.list('task-1'), /Unknown task event type/);
});
