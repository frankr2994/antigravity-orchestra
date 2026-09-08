import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Store } from '../dist-server/db.js';
import { JulesHandoffService } from '../dist-server/application/jules/handoff-service.js';

function fixture() {
  const dbPath = join(tmpdir(), `orchestra-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  const project = store.upsertProject({ name: 'handoff', root: 'F:/handoff', gitRoot: 'F:/handoff' });
  const conversation = store.createSession(project.id, 'Handoff');
  const task = store.createTask(project.id, conversation.id, 'Implement the requested feature completely.', null, null, 'cloud');
  store.updateTask(task.id, { state: 'running' });
  const cloud = store.manager.cloudSessions.create({
    taskId: task.id, sourceName: 'sources/test', sessionResourceName: 'sessions/handoff',
    remoteSessionId: 'handoff', dispatchBranch: 'orchestra/jules/handoff', targetBranch: 'main',
    baseSha: 'a'.repeat(40), state: 'AWAITING_USER_FEEDBACK',
  });
  const close = () => { store.close(); try { rmSync(dbPath, { force: true }); } catch {} };
  return { store, task, cloud, close };
}

function addQuestion(store, taskId, id, message) {
  store.addEvent(taskId, 'jules', 'cloud.activity', {
    providerActivityId: id, createTime: new Date().toISOString(), originator: 'agent',
    kind: 'agent_message', message,
  });
}

function fakeResolver(calls) {
  return {
    resolve: async (input) => {
      calls.push(input.question);
      return {
        response: `Decision for Jules: ${input.question}\nContinue implementation, run checks, update the PR, and complete the session.`,
        handler: 'codex', model: 'gpt-5.6-luna', effort: 'low', reason: 'Ordinary technical clarification.',
        tokenUsage: { input: 10, output: 20, total: 30 }, escalationHistory: [{ model: 'gemma', effort: 'low', reason: 'ordinary' }],
      };
    },
  };
}

function service(input) {
  return new JulesHandoffService(
    input.store,
    { sendMessage: async (_taskId, prompt, key) => { input.messages.push({ prompt, key }); return { ok: true }; } },
    { reconcile: async () => ({ status: 'unused' }) },
    { reviewAndIntegrate: async () => ({ status: 'unused' }) },
    { resolver: fakeResolver(input.resolverCalls), now: () => new Date(input.clock.value), resumeGraceMs: 1_000 },
  );
}

test('technical Jules feedback receives a question-specific response and waits for proven resume', async () => {
  const f = fixture();
  try {
    addQuestion(f.store, f.task.id, 'question-1', 'Does my current approach align, and how should I fix the callback types?');
    const messages = []; const resolverCalls = []; const clock = { value: '2026-08-30T21:00:00.000Z' };
    const handoffs = service({ ...f, messages, resolverCalls, clock });

    const first = await handoffs.reconcile(f.task.id);
    assert.equal(first.status, 'awaiting_provider_resume');
    assert.equal(messages.length, 1);
    assert.match(messages[0].prompt, /callback types/i);
    assert.match(messages[0].key, /question-1/);
    assert.equal(resolverCalls.length, 1);
    assert.equal(f.store.manager.checkpoints.latest(f.task.id, 'jules_automation').data.state, 'awaiting_provider_resume');
    assert.equal(f.store.manager.checkpoints.latest(f.task.id, 'jules_automation').data.effort, 'low');

    const duplicate = await handoffs.reconcile(f.task.id);
    assert.equal(duplicate.status, 'awaiting_provider_resume');
    assert.equal(messages.length, 1, 'the same question must not be sent twice during the resume grace period');

    const afterRestart = service({ ...f, messages, resolverCalls, clock });
    await afterRestart.reconcile(f.task.id);
    assert.equal(messages.length, 1, 'restart recovery must reuse the durable awaiting-resume checkpoint');
    assert.equal(resolverCalls.length, 1, 'restart recovery must not repeat the paid decision');

    f.store.addEvent(f.task.id, 'jules', 'cloud.activity', {
      providerActivityId: 'progress-1', createTime: '2026-08-30T21:00:01.000Z', originator: 'agent',
      kind: 'progress', title: 'Continuing', detail: 'Applying the guidance.',
    });
    f.store.manager.cloudSessions.update(f.cloud.id, { state: 'IN_PROGRESS' });
    const resumed = await afterRestart.reconcile(f.task.id);
    assert.equal(resumed.status, 'provider_resumed');
    assert.equal(f.store.manager.checkpoints.latest(f.task.id, 'jules_automation').data.state, 'provider_resumed');
  } finally { f.close(); }
});

test('a later Jules clarification gets a new handoff identity while unchanged attention is bounded', async () => {
  const f = fixture();
  try {
    const messages = []; const resolverCalls = []; const clock = { value: '2026-08-30T21:00:00.000Z' };
    const handoffs = service({ ...f, messages, resolverCalls, clock });
    addQuestion(f.store, f.task.id, 'question-1', 'Which implementation option should I choose?');
    await handoffs.reconcile(f.task.id);

    addQuestion(f.store, f.task.id, 'question-2', 'Should the migration preserve the old field?');
    await handoffs.reconcile(f.task.id);
    assert.equal(messages.length, 2);
    assert.equal(resolverCalls.length, 2);
    assert.match(messages[1].key, /question-2/);

    clock.value = '2026-08-30T21:00:01.001Z';
    const retry = await handoffs.reconcile(f.task.id);
    assert.equal(retry.status, 'awaiting_provider_resume');
    assert.equal(messages.length, 3, 'only one bounded resume retry is allowed for an unchanged question');
    clock.value = '2026-08-30T21:00:02.002Z';
    const waiting = await handoffs.reconcile(f.task.id);
    assert.equal(waiting.status, 'retry_waiting');
    assert.equal(messages.length, 3, 'the controller must stop before creating a message storm');
  } finally { f.close(); }
});

test('simple permission prompts stay deterministic and authority requests fail closed', async () => {
  const f = fixture();
  try {
    const messages = []; const resolverCalls = []; const clock = { value: '2026-08-30T21:00:00.000Z' };
    const handoffs = service({ ...f, messages, resolverCalls, clock });
    addQuestion(f.store, f.task.id, 'question-continue', 'Should I continue?');
    await handoffs.reconcile(f.task.id);
    assert.equal(resolverCalls.length, 0);
    assert.match(messages[0].prompt, /^Yes\./);

    addQuestion(f.store, f.task.id, 'question-secret', 'Please provide the API key so I can continue.');
    const blocked = await handoffs.reconcile(f.task.id);
    assert.equal(blocked.status, 'authority_blocked');
    assert.equal(messages.length, 1);
    assert.equal(f.store.manager.checkpoints.latest(f.task.id, 'jules_automation').data.state, 'blocked');
  } finally { f.close(); }
});

test('an ambiguous response delivery is reconciled from response-ready state without another model call', async () => {
  const f = fixture();
  try {
    addQuestion(f.store, f.task.id, 'question-delivery', 'Which callback signature should I use?');
    const messages = []; const resolverCalls = []; const clock = { value: '2026-08-30T21:00:00.000Z' };
    let failDelivery = true;
    const makeService = () => new JulesHandoffService(
      f.store,
      { sendMessage: async (_taskId, prompt, key) => {
        messages.push({ prompt, key });
        if (failDelivery) throw new Error('provider acknowledgement is ambiguous');
        return { ok: true };
      } },
      { reconcile: async () => ({ status: 'unused' }) },
      { reviewAndIntegrate: async () => ({ status: 'unused' }) },
      { resolver: fakeResolver(resolverCalls), now: () => new Date(clock.value), resumeGraceMs: 1_000 },
    );

    const first = await makeService().reconcile(f.task.id);
    assert.equal(first.status, 'response_delivery_retry_waiting');
    assert.equal(resolverCalls.length, 1);
    clock.value = '2026-08-30T21:01:00.001Z';
    failDelivery = false;
    const reconciled = await makeService().reconcile(f.task.id);
    assert.equal(reconciled.status, 'awaiting_provider_resume');
    assert.equal(resolverCalls.length, 1, 'the durable resolved response must be reused after restart');
    assert.equal(messages[0].key, messages[1].key, 'delivery reconciliation must reuse the exact command identity');
  } finally { f.close(); }
});

test('malformed historical attention state fails closed before resolving or messaging', async () => {
  const f = fixture();
  try {
    addQuestion(f.store, f.task.id, 'question-corrupt', 'What should I do next?');
    f.store.manager.checkpoints.append({ taskId: f.task.id, stage: 'jules_attention_handoff', data: { version: 1, status: 'made_up' } });
    const messages = []; const resolverCalls = []; const clock = { value: '2026-08-30T21:00:00.000Z' };
    await assert.rejects(() => service({ ...f, messages, resolverCalls, clock }).reconcile(f.task.id), /malformed/i);
    assert.equal(messages.length, 0);
    assert.equal(resolverCalls.length, 0);
  } finally { f.close(); }
});
