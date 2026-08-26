import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectTaskScheduler } from '../dist-server/application/tasks/project-task-scheduler.js';
import { ProjectTaskOwnershipService } from '../dist-server/application/tasks/project-task-ownership-service.js';
import { TaskEventPublisher } from '../dist-server/application/tasks/task-event-publisher.js';
import { TaskControlService } from '../dist-server/application/tasks/task-control-service.js';
import { parseActivityPage, parseDispatchRequest } from '../dist-server/application/jules/requests.js';

test('Modular scheduler — enforces global and per-project concurrency independently', async () => {
  const tasks = new Map([
    ['a1', { id: 'a1', projectId: 'a', state: 'queued' }],
    ['a2', { id: 'a2', projectId: 'a', state: 'queued' }],
    ['b1', { id: 'b1', projectId: 'b', state: 'queued' }],
  ]);
  const started = [];
  const releases = new Map();
  const scheduler = new ProjectTaskScheduler(
    { getTask: (id) => tasks.get(id) },
    (id) => new Promise((resolve) => { started.push(id); releases.set(id, resolve); }),
    2,
  );
  scheduler.enqueue('a1'); scheduler.enqueue('a2'); scheduler.enqueue('b1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a1', 'b1']);
  assert.equal(scheduler.activeTaskId('a'), 'a1');
  releases.get('a1')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['a1', 'b1', 'a2']);
  releases.get('a2')(); releases.get('b1')();
});

test('Modular scheduler — pause waits for process exit and keeps durable project ownership', async () => {
  const tasks = new Map([['paused-task', { id: 'paused-task', projectId: 'project', state: 'queued' }]]);
  let abortReason = null;
  let exited = false;
  const store = {
    getTask: (id) => tasks.get(id),
    listTasks: (projectId) => [...tasks.values()].filter((task) => task.projectId === projectId),
  };
  const scheduler = new ProjectTaskScheduler(store, (_id, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      abortReason = signal.reason;
      setImmediate(() => { exited = true; resolve(); });
    }, { once: true });
  }), 1);
  scheduler.enqueue('paused-task');
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.abortAndWait('paused-task', 'pause');
  assert.equal(abortReason, 'pause');
  assert.equal(exited, true);
  assert.equal(scheduler.isRunning('paused-task'), false);
  tasks.get('paused-task').state = 'paused';
  assert.equal(scheduler.activeTaskId('project'), 'paused-task');
});

test('Modular scheduler — recovery requested during worker cleanup runs after ownership is released', async () => {
  const task = { id: 'recovering-task', projectId: 'project', state: 'queued' };
  const started = [];
  let releaseFirst;
  const scheduler = new ProjectTaskScheduler(
    { getTask: () => task, listTasks: () => [task] },
    (id) => {
      started.push(id);
      if (started.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return Promise.resolve();
    },
    1,
  );

  scheduler.enqueue(task.id);
  task.state = 'recovering';
  scheduler.enqueueAfterCurrent(task.id);
  assert.deepEqual(started, [task.id]);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [task.id, task.id]);
});

test('Modular task controls — pause and resume preserve task identity and scheduler ownership', async () => {
  const task = { id: 'controlled-task', projectId: 'project', target: 'local', state: 'queued' };
  const events = [];
  const enqueued = [];
  const store = {
    getTask: () => task,
    updateTask: (_id, patch) => Object.assign(task, patch),
    manager: { attempts: { listByTaskId: () => [], update: () => {} } },
  };
  const scheduler = {
    remove: () => {},
    isRunning: () => false,
    abortAndWait: async () => {},
    enqueue: (id) => enqueued.push(id),
  };
  const controls = new TaskControlService(store, scheduler, new Map(), (taskId, agent, type, payload) => events.push({ taskId, agent, type, payload }));

  assert.equal((await controls.pause(task.id)).state, 'paused');
  assert.equal(events.at(-1).type, 'task.state');
  assert.equal((await controls.resume(task.id)).state, 'recovering');
  assert.deepEqual(enqueued, [task.id]);
  assert.equal(events.at(-1).payload.state, 'recovering');
});

test('Modular task controls — stop preserves changed files as recoverable work', async () => {
  const task = { id: 'stopped-task', projectId: 'project', target: 'local', state: 'running' };
  const events = [];
  const store = {
    getTask: () => task,
    getProject: () => ({ id: 'project', root: 'F:/project' }),
    updateTask: (_id, patch) => Object.assign(task, patch),
    manager: { attempts: { listByTaskId: () => [], update: () => {} } },
  };
  const scheduler = { remove: () => {}, isRunning: () => false, abortAndWait: async () => {}, enqueue: () => {} };
  const readGitStatus = async () => ({ isGit: true, files: [{ path: 'src/changed.ts', status: 'M' }] });
  const controls = new TaskControlService(store, scheduler, new Map(), (_taskId, _agent, type, payload) => events.push({ type, payload }), readGitStatus);

  const stopped = await controls.stop(task.id);
  assert.equal(stopped.state, 'recovery_required');
  assert.match(stopped.error, /1 changed project file was preserved/);
  assert.equal(events.some((event) => event.type === 'task.recovery-required'), true);
});

test('Modular ownership — never probes or releases a task while its process is running', async () => {
  const task = { id: 'live-recovery', projectId: 'project', target: 'local', state: 'recovery_required' };
  let statusReads = 0;
  const service = new ProjectTaskOwnershipService(
    { getTask: () => task },
    { activeTaskId: () => task.id, isRunning: () => true },
    () => assert.fail('a live owner must not emit a release event'),
    async () => { statusReads += 1; return { isGit: true, files: [] }; },
  );

  assert.equal(await service.reconcile(task.projectId), task);
  assert.equal(statusReads, 0);
});

test('Modular event publisher — persists before broadcasting canonical events', () => {
  const calls = [];
  const event = { id: 1, taskId: 'task', agent: 'system', type: 'task.state', payload: { state: 'running' }, createdAt: new Date().toISOString() };
  const publisher = new TaskEventPublisher({ addEvent: (...args) => { calls.push(['persist', ...args]); return event; } });
  const received = [];
  const unsubscribe = publisher.subscribe('task', (item) => { calls.push(['broadcast']); received.push(item); });
  publisher.publish('task', 'system', 'task.state', { state: 'running' });
  unsubscribe();
  assert.equal(received[0], event);
  assert.equal(calls[0][0], 'persist');
  assert.equal(calls[1][0], 'broadcast');
});

test('Modular request contracts — reject coercion and bound pagination', () => {
  assert.throws(() => parseDispatchRequest({ prompt: 'work', requirePlanApproval: 'false', idempotencyKey: 'one' }), /must be a boolean/);
  assert.throws(() => parseDispatchRequest({ prompt: 'work' }), /idempotency key/i);
  assert.deepEqual(parseDispatchRequest({ prompt: ' work ', idempotencyKey: 'one' }), {
    prompt: 'work', sessionId: undefined, requirePlanApproval: true, autoPr: true, idempotencyKey: 'one',
  });
  assert.throws(() => parseActivityPage({ pageSize: 'NaN' }), /pageSize/);
  assert.throws(() => parseActivityPage({ pageSize: '101' }), /pageSize/);
  assert.deepEqual(parseActivityPage({ pageSize: '25', pageToken: ' next ' }), { pageSize: 25, pageToken: 'next' });
});
