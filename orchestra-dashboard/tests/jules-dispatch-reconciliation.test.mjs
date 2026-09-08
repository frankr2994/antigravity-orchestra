import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Store } from '../dist-server/db.js';
import { JulesSessionManager } from '../dist-server/providers/jules/session-manager.js';
import { JulesSessionService } from '../dist-server/application/jules/session-service.js';
import { CommandIntentRepository } from '../dist-server/infrastructure/database/repositories/intents.js';

test('ambiguous Jules dispatch is reconciled from the unique remote task identity', async () => {
  const dbPath = join(tmpdir(), `orchestra-jules-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  try {
    const project = store.upsertProject({ name: 'wiring', root: 'F:\\Wiring', gitRoot: 'F:\\Wiring' });
    const conversation = store.createSession(project.id, 'Wiring');
    const prompt = 'please continue with the implemented repairs';
    const task = store.createTask(project.id, conversation.id, prompt, null, null, 'cloud');
    const command = {
      prompt,
      sessionId: conversation.id,
      requirePlanApproval: true,
      autoPr: true,
      idempotencyKey: 'ambiguous-dispatch-test',
    };
    const requestHash = CommandIntentRepository.requestHash({ projectId: project.id, ...command });
    const { intent } = store.manager.commandIntents.createOrGet({
      taskId: task.id, kind: 'jules.dispatch', idempotencyKey: command.idempotencyKey, requestHash,
    });
    store.manager.commandIntents.transition(intent.id, 'pending', 'ambiguous', { errorCode: 'JULES_DISPATCH_AMBIGUOUS' });
    store.updateTask(task.id, { state: 'failed', error: 'Dispatch outcome was ambiguous.' });
    store.manager.checkpoints.append({
      taskId: task.id, stage: 'preflight', subjectSha: 'a'.repeat(40),
      data: {
        status: 'verified', sourceName: 'sources/github/example/wiring',
        dispatchBranch: `orchestra/jules/${task.id}`, targetBranch: 'main', baseSha: 'a'.repeat(40),
      },
    });

    let listCalls = 0;
    const client = {
      listSessions: async () => {
        listCalls += 1;
        return { sessions: [{
          name: 'sessions/accepted-123', id: 'accepted-123', title: `Orchestra Task: ${task.id.slice(0, 8)}`,
          prompt, state: 'QUEUED', sourceContext: {
            source: 'sources/github/example/wiring',
            githubRepoContext: { startingBranch: `orchestra/jules/${task.id}` },
          },
        }] };
      },
    };
    const manager = new JulesSessionManager(store);
    const service = new JulesSessionService(store, {}, manager, () => client, client);
    const response = await service.dispatch(project.id, command);

    assert.equal(response.ok, true);
    assert.equal(response.remoteSessionId, 'accepted-123');
    assert.equal(listCalls, 1);
    assert.equal(store.manager.commandIntents.getById(intent.id).state, 'acknowledged');
    assert.equal(store.manager.cloudSessions.getByTaskId(task.id).remoteSessionId, 'accepted-123');
    assert.equal(store.getTask(task.id).state, 'running');
    assert.equal(store.manager.providerRuns.findRunning(task.id, 'jules')?.primaryWorker, true);
  } finally {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('reconciliation refuses a non-unique provider match', async () => {
  const dbPath = join(tmpdir(), `orchestra-jules-reconcile-duplicate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  try {
    const project = store.upsertProject({ name: 'duplicate', root: 'F:\\Duplicate', gitRoot: 'F:\\Duplicate' });
    const conversation = store.createSession(project.id, 'Duplicate');
    const prompt = 'do the work';
    const task = store.createTask(project.id, conversation.id, prompt, null, null, 'cloud');
    const command = { prompt, sessionId: conversation.id, requirePlanApproval: true, autoPr: true, idempotencyKey: 'duplicate-test' };
    const requestHash = CommandIntentRepository.requestHash({ projectId: project.id, ...command });
    const { intent } = store.manager.commandIntents.createOrGet({ taskId: task.id, kind: 'jules.dispatch', idempotencyKey: command.idempotencyKey, requestHash });
    store.manager.commandIntents.transition(intent.id, 'pending', 'ambiguous');
    const branch = `orchestra/jules/${task.id}`;
    store.manager.checkpoints.append({ taskId: task.id, stage: 'preflight', subjectSha: 'b'.repeat(40),
      data: { sourceName: 'sources/github/example/duplicate', dispatchBranch: branch, targetBranch: 'main', baseSha: 'b'.repeat(40) } });
    const identity = { title: `Orchestra Task: ${task.id.slice(0, 8)}`, prompt, state: 'QUEUED',
      sourceContext: { source: 'sources/github/example/duplicate', githubRepoContext: { startingBranch: branch } } };
    const client = { listSessions: async () => ({ sessions: [
      { ...identity, name: 'sessions/one' }, { ...identity, name: 'sessions/two' },
    ] }) };
    const service = new JulesSessionService(store, {}, new JulesSessionManager(store), () => client, client);

    await assert.rejects(() => service.dispatch(project.id, command), (error) => error?.code === 'DISPATCH_RECONCILIATION_REQUIRED');
    assert.equal(store.manager.cloudSessions.getByTaskId(task.id), null);
    assert.equal(store.manager.commandIntents.getById(intent.id).state, 'ambiguous');
  } finally {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('ambiguous Jules feedback reconciliation searches every documented activity page', async () => {
  const dbPath = join(tmpdir(), `orchestra-jules-message-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  try {
    const project = store.upsertProject({ name: 'feedback', root: 'F:\\Feedback', gitRoot: 'F:\\Feedback' });
    const conversation = store.createSession(project.id, 'Feedback');
    const task = store.createTask(project.id, conversation.id, 'Implement the feature', null, null, 'cloud');
    store.updateTask(task.id, { state: 'running' });
    store.manager.cloudSessions.create({
      taskId: task.id, sourceName: 'sources/github/example/feedback', sessionResourceName: 'sessions/feedback',
      remoteSessionId: 'feedback', dispatchBranch: 'orchestra/jules/feedback', targetBranch: 'main',
      baseSha: 'c'.repeat(40), state: 'AWAITING_USER_FEEDBACK',
    });
    const prompt = 'Use the project document lifecycle and continue.';
    const promptHash = createHash('sha256').update(prompt).digest('hex');
    const key = 'feedback-page-reconciliation';
    const requestHash = CommandIntentRepository.requestHash({ taskId: task.id, kind: 'jules.message', promptHash });
    const { intent } = store.manager.commandIntents.createOrGet({ taskId: task.id, kind: 'jules.message', idempotencyKey: key, requestHash });
    store.manager.commandIntents.transition(intent.id, 'pending', 'ambiguous');
    const calls = [];
    const client = {
      listActivities: async (_session, pageSize, pageToken) => {
        calls.push({ pageSize, pageToken });
        if (!pageToken) return { activities: [{ name: 'activities/old', id: 'old', originator: 'agent', progressUpdated: {} }], nextPageToken: 'page-2' };
        return { activities: [{ name: 'activities/message', id: 'message', originator: 'user', userMessaged: { userMessage: prompt } }] };
      },
    };
    const service = new JulesSessionService(store, {}, new JulesSessionManager(store), () => client, client);
    const result = await service.sendMessage(task.id, prompt, key);
    assert.equal(result.reconciled, true);
    assert.deepEqual(calls, [{ pageSize: 100, pageToken: undefined }, { pageSize: 100, pageToken: 'page-2' }]);
    assert.equal(store.manager.commandIntents.getById(intent.id).state, 'acknowledged');
  } finally {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch {}
  }
});
