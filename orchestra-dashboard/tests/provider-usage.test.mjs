import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist-server/db.js';
import { extractCodexQuotas } from '../dist-server/observability.js';
import { ProviderUsageService } from '../dist-server/application/usage/provider-usage-service.js';
import { ProviderRunRecorder } from '../dist-server/application/usage/provider-run-recorder.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-usage-'));
  const store = new Store(join(root, 'usage.db'));
  const project = store.upsertProject({ name: 'usage', root, gitRoot: root });
  const session = store.createSession(project.id);
  const task = store.createTask(project.id, session.id, 'measure providers');
  return { root, store, task };
}

test('Codex quota parser exposes rolling and weekly windows independently', () => {
  const quotas = extractCodexQuotas({
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 60, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      },
    },
  });
  assert.deepEqual(quotas.map((item) => ({ id: item.id, name: item.name, window: item.window, remaining: item.remainingPercent })), [
    { id: 'codex:primary', name: 'Rolling 5-hour limit', window: '5h', remaining: 75 },
    { id: 'codex:secondary', name: 'Weekly limit', window: 'weekly', remaining: 40 },
  ]);
  assert.match(quotas[0].resetsAt, /^2027-/);
});

test('Codex quota parser uses durations rather than assuming primary means weekly', () => {
  const quotas = extractCodexQuotas({ rateLimits: {
    limitId: 'swapped',
    primary: { usedPercent: 10, windowDurationMins: 10_080 },
    secondary: { usedPercent: 20, windowDurationMins: 300 },
  } });
  assert.equal(quotas[0].window, 'weekly');
  assert.equal(quotas[1].window, '5h');
  assert.equal(extractCodexQuotas({ rateLimits: { primary: { windowDurationMins: 90 } } })[0].name, '90m limit');
});

test('provider runs aggregate task, daily, and weekly workload with honest coverage', () => {
  const { root, store, task } = fixture();
  try {
    const gemma = store.startProviderRun({ taskId: task.id, provider: 'gemma', operation: 'repository-answer', primaryWorker: true });
    store.finishProviderRun(gemma.id, 'completed', { inputTokens: 120, outputTokens: 20, totalTokens: 140 });
    const jules = store.startProviderRun({ taskId: task.id, provider: 'jules', operation: 'implementation', primaryWorker: true });
    store.finishProviderRun(jules.id, 'completed');
    const activity = new ProviderUsageService(store, () => Date.now()).activity(task.id);
    assert.equal(activity.gemma.task.invocationCount, 1);
    assert.equal(activity.gemma.rolling24h.totalTokens, 140);
    assert.equal(activity.gemma.rolling7d.coverage, 'exact');
    assert.equal(activity.jules.rolling24h.coverage, 'count-only');
    assert.equal(activity.jules.rolling24h.primaryTaskCount, 1);
    assert.equal(activity.codex.rolling24h.invocationCount, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('provider event recorder converts lifecycle and telemetry events into one completed run', () => {
  const { root, store, task } = fixture();
  try {
    const recorder = new ProviderRunRecorder(store);
    const base = { id: 1, taskId: task.id, createdAt: new Date().toISOString() };
    recorder.observe({ ...base, agent: 'codex', type: 'agent.started', payload: { role: 'review', model: 'gpt-test' } });
    recorder.observe({ ...base, id: 2, agent: 'codex', type: 'provider.telemetry', payload: { usage: { inputTokens: 500, cachedInputTokens: 300, outputTokens: 40, totalTokens: 540 } } });
    recorder.observe({ ...base, id: 3, agent: 'codex', type: 'agent.completed', payload: { role: 'review' } });
    const summary = store.providerUsage('codex', new Date(0).toISOString(), task.id);
    assert.deepEqual({ calls: summary.invocationCount, tokens: summary.totalTokens, cached: summary.cachedInputTokens, coverage: summary.coverage }, { calls: 1, tokens: 540, cached: 300, coverage: 'exact' });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('starting a replacement provider turn closes the interrupted run', () => {
  const { root, store, task } = fixture();
  try {
    const recorder = new ProviderRunRecorder(store);
    const base = { id: 1, taskId: task.id, createdAt: new Date().toISOString(), agent: 'gemma' };
    recorder.observe({ ...base, type: 'agent.started', payload: { role: 'triage' } });
    recorder.observe({ ...base, id: 2, type: 'agent.started', payload: { role: 'sanity-check' } });
    recorder.observe({ ...base, id: 3, type: 'agent.completed', payload: { role: 'sanity-check' } });
    const rows = store.manager.providerRuns.list('gemma', new Date(0).toISOString(), task.id);
    assert.deepEqual(rows.map((run) => run.status), ['cancelled', 'completed']);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('active provider runs can be closed idempotently by durable task identity', () => {
  const { root, store, task } = fixture();
  try {
    store.startProviderRun({ taskId: task.id, provider: 'jules', operation: 'implementation', primaryWorker: true });
    assert.equal(store.finishActiveProviderRun(task.id, 'jules', 'completed')?.status, 'completed');
    assert.equal(store.finishActiveProviderRun(task.id, 'jules', 'completed'), null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('terminal task state closes a provider turn even when the worker throws before agent.failed', () => {
  const { root, store, task } = fixture();
  try {
    const recorder = new ProviderRunRecorder(store);
    const base = { id: 1, taskId: task.id, createdAt: new Date().toISOString() };
    recorder.observe({ ...base, agent: 'antigravity', type: 'agent.started', payload: { phase: 'implementation' } });
    recorder.observe({ ...base, id: 2, agent: 'system', type: 'task.state', payload: { state: 'recovery_required' } });
    assert.equal(store.manager.providerRuns.list('antigravity', new Date(0).toISOString(), task.id)[0].status, 'failed');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
