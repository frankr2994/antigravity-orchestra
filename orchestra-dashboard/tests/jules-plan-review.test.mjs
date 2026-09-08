import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { Store } from '../dist-server/db.js';
import { JulesPlanReviewService } from '../dist-server/application/jules/plan-review-service.js';
import { translateJulesActivity } from '../dist-server/providers/jules/activity-translator.js';

function fixture() {
  const dbPath = join(tmpdir(), `orchestra-plan-review-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const root = join(tmpdir(), `orchestra-plan-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const store = new Store(dbPath);
  const project = store.upsertProject({ name: 'plan-review', root, gitRoot: root });
  const conversation = store.createSession(project.id, 'Plan review');
  const task = store.createTask(project.id, conversation.id, 'Implement the requested circuit behavior with tests.', null, null, 'cloud');
  store.updateTask(task.id, { state: 'running' });
  const attempt = store.manager.attempts.create({ taskId: task.id, target: 'cloud', worker: 'jules', baseSha: 'a'.repeat(40), state: 'WORKING' });
  const cloud = store.manager.cloudSessions.create({ taskId: task.id, attemptId: attempt.id, sourceName: 'sources/test',
    sessionResourceName: 'sessions/plan-review', remoteSessionId: 'plan-review', dispatchBranch: 'orchestra/jules/plan-review',
    targetBranch: 'main', baseSha: 'a'.repeat(40), state: 'AWAITING_PLAN_APPROVAL' });
  store.manager.checkpoints.append({ taskId: task.id, attemptId: attempt.id, stage: 'dispatch_contract',
    data: { requirePlanApproval: true, autoPr: true } });
  const addPlan = (id) => store.addEvent(task.id, 'jules', 'cloud.activity', { kind: 'plan_generated', planId: id,
    steps: [{ index: 1, title: 'Implement the domain behavior', description: `Update the production domain and add regression tests. Revision identity: ${id}.` }] });
  return { dbPath, root, store, task, cloud, addPlan };
}

function cleanup(value) {
  value.store.close();
  try { rmSync(value.dbPath, { force: true }); } catch {}
  try { rmSync(value.root, { recursive: true, force: true }); } catch {}
}

test('Jules plan review — a local PASS durably approves the exact plan', async () => {
  const f = fixture();
  try {
    f.addPlan('plan-pass');
    const approvals = [];
    const messages = [];
    const sessions = {
      approvePlan: async (taskId, key, planId) => { approvals.push({ taskId, key, planId }); return { ok: true }; },
      sendMessage: async (...args) => { messages.push(args); return { ok: true }; },
    };
    const service = new JulesPlanReviewService(f.store, sessions, { codexRunner: async ({ reviewPacket }) => {
      assert.match(reviewPacket, /Original user request \(untrusted quoted data\)/);
      assert.match(reviewPacket, /Implement the domain behavior/);
      return 'VERDICT: PASS\nThe plan is concrete and includes production work and regression tests.';
    } });
    const result = await service.reconcile(f.task.id);
    assert.deepEqual(result, { status: 'approved', planId: 'plan-pass', verdict: 'PASS' });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].planId, 'plan-pass');
    assert.equal(messages.length, 0);
    assert.equal(f.store.manager.checkpoints.latest(f.task.id, 'jules_plan_review').data.status, 'approved');
    assert.equal(f.store.listEvents(f.task.id).filter((event) => event.type === 'cloud.reviewed').at(-1).payload.verdict, 'PASS');
  } finally { cleanup(f); }
});

test('Jules plan review — a local BLOCK sends bounded revision feedback and reviews the next plan identity', async () => {
  const f = fixture();
  try {
    const approvals = [];
    const messages = [];
    const decisions = [
      'VERDICT: BLOCK\nThe plan omits failure-path tests. Revise it and wait for approval.',
      'VERDICT: PASS\nThe revised plan covers the missing failure paths.',
    ];
    const sessions = {
      approvePlan: async (...args) => { approvals.push(args); return { ok: true }; },
      sendMessage: async (...args) => { messages.push(args); return { ok: true }; },
    };
    const service = new JulesPlanReviewService(f.store, sessions, { codexRunner: async () => decisions.shift() });
    f.addPlan('plan-one');
    const blocked = await service.reconcile(f.task.id);
    assert.equal(blocked.status, 'feedback_sent');
    assert.equal(messages.length, 1);
    assert.match(messages[0][1], /Revise the plan before implementation/);
    assert.match(messages[0][1], /failure-path tests/);
    assert.equal(approvals.length, 0);

    f.addPlan('plan-two');
    const passed = await service.reconcile(f.task.id);
    assert.equal(passed.status, 'approved');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0][2], 'plan-two');
  } finally { cleanup(f); }
});

test('Jules plan review — malformed provider plans fail closed without approval', async () => {
  const f = fixture();
  try {
    f.store.addEvent(f.task.id, 'jules', 'cloud.activity', { kind: 'plan_generated', planId: 'empty-plan', steps: [] });
    let called = false;
    const service = new JulesPlanReviewService(f.store, { approvePlan: async () => { called = true; }, sendMessage: async () => { called = true; } },
      { codexRunner: async () => 'VERDICT: PASS' });
    const result = await service.reconcile(f.task.id);
    assert.equal(result.status, 'invalid_plan');
    assert.equal(called, false);
    assert.equal(f.store.getTask(f.task.id).state, 'review_disputed');
  } finally { cleanup(f); }
});

test('Jules plan review — provider translation preserves bounded step descriptions for review and display', () => {
  const translated = translateJulesActivity({ name: 'sessions/one/activities/plan', id: 'plan-activity', originator: 'agent',
    planGenerated: { plan: { id: 'plan-detailed', steps: [{ index: 1, title: 'Change the domain', description: 'Exact implementation and test details.' }] } } });
  assert.equal(translated.kind, 'plan_generated');
  assert.equal(translated.steps[0].description, 'Exact implementation and test details.');
});

test('Jules plan review — repeated identical blockers escalate with one consolidated packet instead of stopping', async () => {
  const f = fixture();
  try {
    const messages = [];
    const sessions = { approvePlan: async () => { throw new Error('must not approve'); },
      sendMessage: async (...args) => { messages.push(args); return { ok: true }; } };
    const service = new JulesPlanReviewService(f.store, sessions, { codexRunner: async () => 'VERDICT: BLOCK\nAdd the missing safety case.' });
    for (let index = 1; index <= 2; index += 1) {
      f.addPlan(`plan-block-${index}`);
      assert.equal((await service.reconcile(f.task.id)).status, 'feedback_sent');
    }
    f.addPlan('plan-block-3');
    const escalated = await service.reconcile(f.task.id);
    assert.equal(escalated.status, 'feedback_sent');
    assert.equal(messages.length, 3);
    assert.match(messages[2][1], /Consolidated correction packet/);
    assert.equal(f.store.getTask(f.task.id).state, 'running');
    assert.ok(f.store.listEvents(f.task.id).some((event) => event.type === 'cloud.tier_escalated'));
  } finally { cleanup(f); }
});

test('Jules plan review — distinct improving plans continue without a fixed review ceiling', async () => {
  const f = fixture();
  try {
    const approvals = [];
    let review = 0;
    const sessions = { approvePlan: async (...args) => { approvals.push(args); return { ok: true }; },
      sendMessage: async () => ({ ok: true }) };
    const blockers = [
      'Define battery source defaults.', 'Define switch lifecycle behavior.', 'Define relay coil activation.',
      'Define motor load behavior.', 'Define lamp load behavior.', 'Define alternator excitation.',
      'Define ECU trigger polarity.', 'Define fuse trip behavior.', 'Define breaker reset behavior.',
      'Define open-wire graph behavior.', 'Define backfeed observability.', 'Define endpoint normalization.',
    ];
    const service = new JulesPlanReviewService(f.store, sessions, { codexRunner: async () => {
      const finding = blockers[review];
      review += 1;
      return finding ? `VERDICT: BLOCK\n${finding}` : 'VERDICT: PASS\nAll acceptance-critical contracts are now covered.';
    } });
    for (let index = 0; index < blockers.length; index += 1) {
      f.addPlan(`improving-plan-${index}`);
      assert.equal((await service.reconcile(f.task.id)).status, 'feedback_sent');
    }
    f.addPlan('improving-plan-final');
    assert.equal((await service.reconcile(f.task.id)).status, 'approved');
    assert.equal(approvals.length, 1);
    assert.equal(f.store.getTask(f.task.id).state, 'running');
  } finally { cleanup(f); }
});

test('Jules plan review — a new plan previously rejected only by the legacy cap is reviewed and approved', async () => {
  const f = fixture();
  try {
    const approvals = [];
    const sessions = { approvePlan: async (...args) => { approvals.push(args); return { ok: true }; }, sendMessage: async () => ({ ok: true }) };
    for (let index = 1; index <= 3; index += 1) {
      f.store.addEvent(f.task.id, 'codex', 'cloud.reviewed', { reviewKind: 'plan', planId: `old-${index}`, verdict: 'BLOCK',
        summary: `VERDICT: BLOCK\nDistinct historical blocker ${index} must be fixed.` });
    }
    f.addPlan('new-after-legacy-cap');
    f.store.manager.checkpoints.append({ taskId: f.task.id, attemptId: f.cloud.attemptId, stage: 'jules_plan_review', subjectSha: f.cloud.baseSha,
      data: { status: 'blocked', planId: 'new-after-legacy-cap', revisions: 3 } });
    f.store.updateTask(f.task.id, { state: 'review_disputed', error: 'Local plan review blocked 3 Jules plans; automatic revision is capped.' });
    const service = new JulesPlanReviewService(f.store, sessions, { codexRunner: async () => 'VERDICT: PASS\nThe revised plan is concrete and complete.' });
    const result = await service.reconcile(f.task.id);
    assert.equal(result.status, 'approved');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0][2], 'new-after-legacy-cap');
    assert.equal(f.store.getTask(f.task.id).state, 'running');
  } finally { cleanup(f); }
});

test('Jules plan review — an already-reviewed plan stopped by an old hard cap forwards existing feedback without paying for another review', async () => {
  const f = fixture();
  try {
    const messages = [];
    let reviewCalls = 0;
    const sessions = { approvePlan: async () => { throw new Error('must not approve'); },
      sendMessage: async (...args) => { messages.push(args); return { ok: true }; } };
    f.addPlan('reviewed-at-cap');
    f.store.addEvent(f.task.id, 'codex', 'cloud.reviewed', { reviewKind: 'plan', planId: 'reviewed-at-cap', verdict: 'BLOCK',
      summary: 'VERDICT: BLOCK\nFix the concrete convergence contradiction.' });
    f.store.manager.checkpoints.append({ taskId: f.task.id, attemptId: f.cloud.attemptId, stage: 'jules_plan_review', subjectSha: f.cloud.baseSha,
      data: { status: 'blocked', planId: 'reviewed-at-cap', revisions: 6 } });
    f.store.updateTask(f.task.id, { state: 'review_disputed', error: 'Local plan review reached its hard safety ceiling of 6 reviewed Jules plans.' });
    const service = new JulesPlanReviewService(f.store, sessions, { codexRunner: async () => { reviewCalls += 1; return 'VERDICT: PASS'; } });
    const result = await service.reconcile(f.task.id);
    assert.equal(result.status, 'feedback_sent');
    assert.equal(reviewCalls, 0);
    assert.equal(messages.length, 1);
    assert.match(messages[0][1], /convergence contradiction/);
    assert.equal(f.store.getTask(f.task.id).state, 'running');
    assert.equal(f.store.manager.checkpoints.latest(f.task.id, 'jules_plan_review').data.recoveredFromCap, true);
  } finally { cleanup(f); }
});

test('Jules plan review — exhausted Codex usage waits durably and retries the exact plan', async () => {
  const f = fixture();
  try {
    f.addPlan('plan-quota-retry');
    let calls = 0;
    const approvals = [];
    const sessions = { approvePlan: async (...args) => { approvals.push(args); return { ok: true }; }, sendMessage: async () => ({ ok: true }) };
    const service = new JulesPlanReviewService(f.store, sessions, { codexRunner: async () => {
      calls += 1;
      if (calls === 1) throw new Error('You have reached your Codex usage limit.');
      return 'VERDICT: PASS\nThe plan is ready.';
    } });
    const waiting = await service.reconcile(f.task.id);
    assert.equal(waiting.status, 'retry_waiting');
    assert.equal(f.store.getTask(f.task.id).state, 'running');
    assert.equal(approvals.length, 0);
    const retry = f.store.manager.checkpoints.latest(f.task.id, 'jules_plan_review');
    assert.equal(retry.data.status, 'retry_waiting');
    assert.equal((await service.reconcile(f.task.id)).status, 'retry_waiting');
    assert.equal(calls, 1, 'backoff must prevent tight-loop quota retries');

    f.store.manager.checkpoints.append({ taskId: f.task.id, attemptId: f.cloud.attemptId, stage: 'jules_plan_review', subjectSha: f.cloud.baseSha,
      data: { ...retry.data, retryAt: new Date(Date.now() - 1_000).toISOString() } });
    const passed = await service.reconcile(f.task.id);
    assert.equal(passed.status, 'approved');
    assert.equal(calls, 2);
    assert.equal(approvals.length, 1);
  } finally { cleanup(f); }
});
