import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist-server/db.js';
import { git } from '../dist-server/git.js';
import { config } from '../dist-server/config.js';
import { CredentialVault } from '../dist-server/infrastructure/security/vault.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';
import { JulesConnectionService } from '../dist-server/application/jules/connection-service.js';
import { JulesDashboardService } from '../dist-server/application/jules/dashboard-service.js';
import { composeJulesRouter } from '../dist-server/bootstrap/jules-module.js';
import { createBootstrapRouter } from '../dist-server/api/routes/bootstrap.js';
import { errorHandlerMiddleware } from '../dist-server/api/middleware/error.js';
import { closeCodexAppServer } from '../dist-server/codex-app-server.js';

const protector = {
  scheme: 'windows-dpapi-current-user',
  protect: (plaintext) => Buffer.from(plaintext).reverse(),
  unprotect: (ciphertext) => Buffer.from(ciphertext).reverse(),
};
const headers = { 'X-Orchestra-Token': config.uiToken, 'Content-Type': 'application/json' };
const okJson = (value) => ({ ok: true, status: 200, json: async () => value });
const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});
after(() => closeCodexAppServer());

async function fixture(name) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const root = join(tmpdir(), `${name}-repo-${suffix}`);
  const dbPath = join(tmpdir(), `${name}-${suffix}.db`);
  const vaultPath = join(tmpdir(), `${name}-${suffix}.vault`);
  mkdirSync(root, { recursive: true });
  await git(['init'], root);
  await git(['config', 'user.name', 'Jules Dashboard Test'], root);
  await git(['config', 'user.email', 'test@orchestra.local'], root);
  writeFileSync(join(root, 'README.md'), '# fixture');
  await git(['add', 'README.md'], root);
  await git(['commit', '-m', 'initial'], root);
  await git(['branch', '-M', 'main'], root);
  const store = new Store(dbPath);
  const vault = new CredentialVault(vaultPath, protector);
  const project = store.upsertProject({ name, root, gitRoot: root });
  const session = store.createSession(project.id, name);
  return {
    root, dbPath, vaultPath, store, vault, project, session,
    async cleanup() {
      store.close();
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      try { rmSync(dbPath, { force: true }); } catch {}
      try { rmSync(vaultPath, { force: true }); } catch {}
    },
  };
}

test('Jules settings API persists explicit plans and validates preset/custom limits', async () => {
  const f = await fixture('jules-settings');
  let server;
  try {
    const app = express(); app.use(express.json());
    app.use('/api', composeJulesRouter({ store: f.store, vault: f.vault, rolloutStage: 'connect' }));
    app.use(errorHandlerMiddleware);
    server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/jules/settings`;

    const required = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ enabled: true }) });
    assert.equal(required.status, 400); assert.equal((await required.json()).code, 'JULES_QUOTA_PLAN_REQUIRED');
    for (const [quotaPlan, rolling24HourLimit] of [['free', 15], ['pro', 100], ['ultra', 300], ['custom', 777]]) {
      const response = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ quotaPlan, rolling24HourLimit }) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { enabled: false, rolloutStage: 'off', quotaPlan, rolling24HourLimit });
    }
    const invalidPreset = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ quotaPlan: 'pro', rolling24HourLimit: 99 }) });
    assert.equal(invalidPreset.status, 400); assert.equal((await invalidPreset.json()).code, 'INVALID_JULES_QUOTA_LIMIT');
    const invalidCustom = await fetch(base, { method: 'PATCH', headers, body: JSON.stringify({ quotaPlan: 'custom', rolling24HourLimit: 10001 }) });
    assert.equal(invalidCustom.status, 400);
  } finally {
    if (server) await closeServer(server);
    await f.cleanup();
  }
});

test('Jules rolling usage pages, deduplicates, excludes the exact boundary, caches, forces, and fails closed', async () => {
  const f = await fixture('jules-usage');
  const now = Date.now();
  let calls = 0;
  let mode = 'valid';
  const client = new JulesApiClient({ apiKey: 'AIzaSy-test-secret-never-log', maxRetries: 0, fetchFn: async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/sessions')) return okJson({ sources: [] });
    calls += 1;
    if (mode === 'malformed') return okJson({ sessions: [{ name: 'sessions/missing-time', state: 'QUEUED' }] });
    if (mode === 'loop') return okJson({ sessions: [], nextPageToken: 'same' });
    if (!url.searchParams.get('pageToken')) return okJson({ sessions: [
      { name: 'sessions/a', state: 'QUEUED', createTime: new Date(now - 60 * 60_000).toISOString() },
      { name: 'sessions/boundary', state: 'COMPLETED', createTime: new Date(now - 24 * 60 * 60_000).toISOString() },
    ], nextPageToken: 'next' });
    return okJson({ sessions: [
      { name: 'sessions/a', state: 'IN_PROGRESS', createTime: new Date(now - 60 * 60_000).toISOString() },
      { name: 'sessions/external', state: 'COMPLETED', createTime: new Date(now - 2 * 60 * 60_000).toISOString() },
      { name: 'sessions/old', state: 'FAILED', createTime: new Date(now - 25 * 60 * 60_000).toISOString() },
    ] });
  }});
  const connection = new JulesConnectionService(f.store, f.vault, client);
  connection.setRuntimeSettings({ quotaPlan: 'free', rolling24HourLimit: 15 });
  connection.setRuntimeSettings({ enabled: true });
  const dashboard = new JulesDashboardService(f.store, connection, () => now, async () => 'unused');
  try {
    const usage = await dashboard.usage();
    assert.equal(usage.usedCount, 2, 'account-wide external sessions count, while duplicates and the exact boundary do not');
    assert.equal(usage.remainingCount, 13); assert.equal(usage.activeSessions, 1);
    assert.equal(usage.nextSlotAt, new Date(now + 22 * 60 * 60_000).toISOString());
    assert.equal(calls, 2);
    await dashboard.usage(); assert.equal(calls, 2, 'successful account usage is cached for 60 seconds');
    await dashboard.usage(true); assert.equal(calls, 4, 'forced refresh bypasses the cache');

    mode = 'malformed';
    const malformed = await dashboard.usage(true);
    assert.equal(malformed.available, false); assert.equal(malformed.stale, true); assert.equal(malformed.usedCount, 2, 'malformed responses never replace the last verified count');
    mode = 'loop';
    const loop = await dashboard.usage(true);
    assert.equal(loop.available, false); assert.equal(loop.stale, true);

    const beforeDisable = calls;
    connection.setRuntimeSettings({ enabled: false });
    const disabled = await dashboard.usage(true);
    assert.equal(calls, beforeDisable, 'disabled mode performs no provider requests');
    assert.equal(disabled.stale, true); assert.equal(disabled.limitCount, 15);
  } finally { await f.cleanup(); }
});

test('Jules readiness covers disabled, configuration, repository, provider, branch, capacity, and green states', async () => {
  const f = await fixture('jules-ready');
  const now = Date.now();
  let mode = 'connected';
  const client = new JulesApiClient({ apiKey: 'test-key', maxRetries: 0, fetchFn: async (input) => {
    const url = new URL(String(input));
    if (mode === 'outage') return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ error: { message: 'down' } }) };
    if (url.pathname.endsWith('/sources')) {
      if (mode === 'source-missing') return okJson({ sources: [] });
      const branches = mode === 'branch-missing' ? [{ displayName: 'dev' }] : [{ displayName: 'main' }];
      return okJson({ sources: [{ name: 'sources/github/acme/widget', githubRepo: { owner: 'acme', repo: 'widget', branches } }] });
    }
    if (url.pathname.endsWith('/sessions')) {
      if (mode === 'malformed') return okJson({ sessions: [{ name: 'sessions/no-time', state: 'QUEUED' }] });
      const count = mode === 'exhausted' ? 2 : 1;
      return okJson({ sessions: Array.from({ length: count }, (_, index) => ({ name: `sessions/${index}`, state: 'COMPLETED', createTime: new Date(now - (index + 1) * 60_000).toISOString() })) });
    }
    return okJson({});
  }});
  const connection = new JulesConnectionService(f.store, f.vault, client);
  const dashboard = new JulesDashboardService(f.store, connection, () => now, async () => 'unused');
  try {
    assert.equal((await dashboard.readiness(f.project.id)).status, 'red');
    connection.setRuntimeSettings({ quotaPlan: 'custom', rolling24HourLimit: 5 }); connection.setRuntimeSettings({ enabled: true });
    assert.equal((await dashboard.readiness(f.project.id)).action, 'configure', 'missing credentials require configuration');
    f.vault.setSecret('jules_api_key', 'test-key');
    assert.equal((await dashboard.readiness('missing-project')).status, 'yellow');
    assert.equal((await dashboard.readiness(f.project.id)).action, 'setup_repository', 'a missing GitHub remote requires setup');
    await git(['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], f.root);
    mode = 'source-missing'; assert.equal((await dashboard.readiness(f.project.id, true)).action, 'setup_repository');
    mode = 'branch-missing'; assert.equal((await dashboard.readiness(f.project.id, true)).action, 'setup_repository');
    mode = 'outage'; assert.equal((await dashboard.readiness(f.project.id, true)).action, 'retry');
    mode = 'malformed'; assert.equal((await dashboard.readiness(f.project.id, true)).action, 'retry');
    connection.setRuntimeSettings({ quotaPlan: 'custom', rolling24HourLimit: 1 });
    mode = 'exhausted'; assert.match((await dashboard.readiness(f.project.id, true)).diagnostic, /exhausted/);
    connection.setRuntimeSettings({ quotaPlan: 'custom', rolling24HourLimit: 5 });
    mode = 'connected'; assert.equal((await dashboard.readiness(f.project.id, true)).status, 'green');
  } finally { await f.cleanup(); }
});

test('Jules setup diagnosis uses exact sanitized repository facts and activity stays project-scoped and bounded', async () => {
  const f = await fixture('jules-activity');
  const otherRoot = `${f.root}-other`;
  const now = Date.now();
  let advisorInput;
  const client = new JulesApiClient({ apiKey: 'super-secret-key', maxRetries: 0, fetchFn: async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/sources')) return okJson({ sources: [{ name: 'sources/github/acme/activity', githubRepo: { owner: 'acme', repo: 'activity', branches: [{ displayName: 'main' }] } }] });
    return okJson({ sessions: [] });
  }});
  f.vault.setSecret('jules_api_key', 'super-secret-key');
  await git(['remote', 'add', 'origin', 'https://github.com/acme/activity.git'], f.root);
  const connection = new JulesConnectionService(f.store, f.vault, client);
  connection.setRuntimeSettings({ quotaPlan: 'free', rolling24HourLimit: 15 }); connection.setRuntimeSettings({ enabled: true });
  const dashboard = new JulesDashboardService(f.store, connection, () => now, async (input) => { advisorInput = input; return 'Authorize this repository yourself in the official interface.'; });
  let server;
  try {
    const otherProject = f.store.upsertProject({ name: 'other', root: otherRoot, gitRoot: null });
    const otherSession = f.store.createSession(otherProject.id, 'other');
    const states = ['QUEUED', 'PLANNING', 'IN_PROGRESS', 'AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'PAUSED', 'COMPLETED', 'FAILED'];
    for (let index = 0; index < 25; index += 1) {
      const task = f.store.createTask(f.project.id, f.session.id, `project task ${index}`, null, null, 'cloud');
      const cloud = f.store.manager.cloudSessions.create({ taskId: task.id, sourceName: 'sources/github/acme/activity', sessionResourceName: `sessions/project-${index}`, remoteSessionId: `project-${index}`, dispatchBranch: 'main', targetBranch: 'main', baseSha: 'a'.repeat(40), state: states[index % states.length] });
      if (index === 24) f.store.manager.cloudSessions.update(cloud.id, { prUrl: 'https://github.com/acme/activity/pull/24' });
    }
    const oldTask = f.store.createTask(f.project.id, f.session.id, 'old task', null, null, 'cloud');
    const oldCloud = f.store.manager.cloudSessions.create({ taskId: oldTask.id, sourceName: 'sources/github/acme/activity', sessionResourceName: 'sessions/old', remoteSessionId: 'old', dispatchBranch: 'main', targetBranch: 'main', baseSha: 'b'.repeat(40), state: 'FAILED' });
    f.store.manager.db.prepare('UPDATE cloud_sessions SET created_at=?,updated_at=? WHERE id=?').run(new Date(now - 25 * 60 * 60_000).toISOString(), new Date(now - 25 * 60 * 60_000).toISOString(), oldCloud.id);
    const foreignTask = f.store.createTask(otherProject.id, otherSession.id, 'foreign task', null, null, 'cloud');
    f.store.manager.cloudSessions.create({ taskId: foreignTask.id, sourceName: 'sources/github/other/repo', sessionResourceName: 'sessions/foreign', remoteSessionId: 'foreign', dispatchBranch: 'main', targetBranch: 'main', baseSha: 'c'.repeat(40), state: 'FAILED' });

    const summary = dashboard.activitySummary(f.project.id);
    assert.deepEqual(summary.totals, { working: 10, attention: 9, completed: 3, failed: 3 });
    assert.equal(summary.tasks.length, 20); assert.ok(summary.tasks.some((task) => task.prUrl?.endsWith('/24')));
    assert.ok(summary.tasks.every((task) => task.title !== 'foreign task' && task.title !== 'old task'));

    const diagnosis = await dashboard.setupDiagnosis(f.project.id);
    assert.equal(diagnosis.repository, 'acme/activity'); assert.equal(diagnosis.authorized, true); assert.equal(diagnosis.advisor, 'gemma');
    assert.match(advisorInput.prompt, /acme\/activity/); assert.doesNotMatch(advisorInput.prompt, /super-secret-key/);

    const app = express(); app.use(express.json());
    app.use('/api', createBootstrapRouter(f.store, { julesUsage: (force) => dashboard.usage(force) }));
    app.use('/api', composeJulesRouter({ store: f.store, vault: f.vault, julesClient: client, connectionService: connection, dashboardService: dashboard, rolloutStage: 'auto' }));
    app.use(errorHandlerMiddleware); server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const activityResponse = await fetch(`${base}/projects/${f.project.id}/jules-activity-summary`, { headers });
    assert.equal(activityResponse.status, 200); assert.equal((await activityResponse.json()).tasks.length, 20);
    const usageResponse = await fetch(`${base}/usage?force=true`);
    const usageBody = await usageResponse.json(); assert.equal(usageBody.jules.limitCount, 15);
  } finally {
    if (server) await closeServer(server);
    await f.cleanup();
    try { rmSync(otherRoot, { recursive: true, force: true }); } catch {}
  }
});

test('Jules dashboard UI exposes three-state readiness, guided setup, and provider-completion wording', () => {
  const ui = readFileSync(new URL('../src/features/jules/JulesDashboard.tsx', import.meta.url), 'utf8');
  assert.match(ui, /setup-diagnosis/); assert.match(ui, /window\.addEventListener\('focus'/); assert.match(ui, /Recheck/);
  assert.match(ui, /Completed by Jules means provider execution finished/); assert.match(ui, /Jules is idle/); assert.match(ui, /summary\.tasks\.map/);
  const primitives = readFileSync(new URL('../src/shared/ui.tsx', import.meta.url), 'utf8');
  assert.match(primitives, /'red' \| 'yellow' \| 'green'/);
});
