import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectTaskScheduler } from '../dist-server/application/tasks/project-task-scheduler.js';
import { TaskEventPublisher } from '../dist-server/application/tasks/task-event-publisher.js';
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
