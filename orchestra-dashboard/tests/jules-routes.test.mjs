import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import express from 'express';
import { git } from '../dist-server/git.js';
import { Store } from '../dist-server/db.js';
import { CredentialVault } from '../dist-server/infrastructure/security/vault.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';
import { createJulesRouter } from '../dist-server/api/routes/jules.js';

// ============================================================================
// Phase 16 Cloud Execution Route Controller & Routes Test Suite
// ============================================================================

test('Phase 16 Routes — Credential and source endpoints', async () => {
  const dbPath = join(tmpdir(), `orchestra-rt-cred-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const vaultPath = join(tmpdir(), `orchestra-rt-vault-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  let server;
  let store;

  try {
    store = new Store(dbPath);
    const vault = new CredentialVault(vaultPath);

    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/sources')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sources: [] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const julesClient = new JulesApiClient({ apiKey: 'test-key', fetchFn: mockFetch });

    const app = express();
    app.use(express.json());
    app.use('/api', createJulesRouter({ store, vault, julesClient }));

    server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/api`;

    // 1. Initial credential status
    const statRes = await fetch(`${baseUrl}/jules/credential-status`);
    assert.equal(statRes.status, 200);
    const statData = await statRes.json();
    assert.equal(typeof statData.configured, 'boolean');

    // 2. Save key
    const saveRes = await fetch(`${baseUrl}/jules/save-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'new-vault-api-key', validate: false }),
    });
    assert.equal(saveRes.status, 200);
    const saveData = await saveRes.json();
    assert.equal(saveData.ok, true);

    // 3. Clear key
    const clearRes = await fetch(`${baseUrl}/jules/clear-key`, { method: 'DELETE' });
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.ok, true);
  } finally {
    if (server) server.close();
    if (store) store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(vaultPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 16 Routes — Task cloud dispatch, session retrieval, plan approval, feedback, and cancel', async () => {
  const dbPath = join(tmpdir(), `orchestra-rt-disp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const vaultPath = join(tmpdir(), `orchestra-rt-vault2-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const fixtureDir = join(tmpdir(), `orchestra-rt-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const bareDir = join(tmpdir(), `orchestra-rt-bare-${Date.now()}-${Math.random().toString(36).slice(2)}.git`);
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(bareDir, { recursive: true });

  let server;
  let store;

  try {
    // Setup bare repo as remote origin
    await git(['init', '--bare'], bareDir);

    // Setup working repo
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Route Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    writeFileSync(join(fixtureDir, 'README.md'), '# Route Dispatch Test');
    await git(['add', 'README.md'], fixtureDir);
    await git(['commit', '-m', 'Initial commit'], fixtureDir);
    await git(['branch', '-M', 'main'], fixtureDir);

    // Origin URL is GitHub (for source matching) and Push URL is local bare repository
    await git(['remote', 'add', 'origin', 'https://github.com/frankr2994/antigravity-orchestra.git'], fixtureDir);
    await git(['remote', 'set-url', '--push', 'origin', bareDir], fixtureDir);
    await git(['push', '-u', 'origin', 'main'], fixtureDir);

    store = new Store(dbPath);
    const vault = new CredentialVault(vaultPath);
    vault.setSecret('jules_api_key', 'test-route-key');

    const project = store.upsertProject({ name: 'route-test-proj', root: fixtureDir, gitRoot: fixtureDir });
    const session = store.createSession(project.id, 'Route Test Session');

    let approvedPlan = false;
    let feedbackReceived = '';
    let remoteCancelled = false;

    const mockFetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('approvePlan')) {
        approvedPlan = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (urlStr.includes('sendMessage') || urlStr.includes('sendFeedback')) {
        const body = JSON.parse(String(opts?.body || '{}'));
        feedbackReceived = body.prompt || body.message || '';
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (urlStr.includes('pause')) {
        remoteCancelled = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (urlStr.includes('resume')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (urlStr.includes('/activities')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            activities: [
              { name: 'activities/act-1', id: 'act-1', type: 'THOUGHT', description: 'Examining files' },
            ],
          }),
        };
      }
      if (urlStr.includes('/sources')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sources: [{ name: 'sources/github/frankr2994/antigravity-orchestra', githubRepo: { owner: 'frankr2994', repo: 'antigravity-orchestra' } }],
          }),
        };
      }
      if (urlStr.includes('/sessions') && opts?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'sessions/sess-route-100',
            id: 'sess-route-100',
            state: 'PLANNING',
          }),
        };
      }
      if (urlStr.includes('/sessions') && opts?.method === 'DELETE') {
        remoteCancelled = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const julesClient = new JulesApiClient({ apiKey: 'test-route-key', fetchFn: mockFetch });

    const app = express();
    app.use(express.json());
    app.use('/api', createJulesRouter({ store, vault, julesClient }));

    server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/api`;

    // 1. Dispatch task to cloud (using real bare git push without skipPush)
    const dispatchRes = await fetch(`${baseUrl}/projects/${project.id}/jules/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Add cloud execution router test',
        sessionId: session.id,
      }),
    });
    assert.equal(dispatchRes.status, 201);
    const dispatchData = await dispatchRes.json();
    assert.equal(dispatchData.ok, true);
    assert.equal(dispatchData.remoteSessionId, 'sess-route-100');
    const taskId = dispatchData.taskId;

    // 2. Get task session
    const getSessRes = await fetch(`${baseUrl}/tasks/${taskId}/jules-session`);
    assert.equal(getSessRes.status, 200);
    const getSessData = await getSessRes.json();
    assert.equal(getSessData.cloudSession.remoteSessionId, 'sess-route-100');

    // 3. Approve plan
    const approveRes = await fetch(`${baseUrl}/tasks/${taskId}/jules/approve-plan`, {
      method: 'POST',
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approvedPlan, true);

    // 4. Send feedback
    const feedbackRes = await fetch(`${baseUrl}/tasks/${taskId}/jules/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Focus on error handling' }),
    });
    assert.equal(feedbackRes.status, 200);
    assert.equal(feedbackReceived, 'Focus on error handling');

    // 5. List activities
    const actRes = await fetch(`${baseUrl}/tasks/${taskId}/jules/activities`);
    assert.equal(actRes.status, 200);
    const actData = await actRes.json();
    assert.equal(actData.activities.length, 1);
    assert.equal(actData.activities[0].id, 'act-1');

    // 6. Cancel session
    const cancelRes = await fetch(`${baseUrl}/tasks/${taskId}/jules/cancel`, {
      method: 'POST',
    });
    assert.equal(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.equal(cancelData.ok, true);
    assert.equal(remoteCancelled, true);

    // 7. Feature-gated import-pr endpoint returns 501
    const importRes = await fetch(`${baseUrl}/tasks/${taskId}/jules/import-pr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prHeadSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }),
    });
    assert.equal(importRes.status, 501);
    const importData = await importRes.json();
    assert.equal(importData.code, 'FEATURE_GATED');
  } finally {
    if (server) server.close();
    if (store) store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(vaultPath, { force: true }); } catch { /* Windows file lock */ }
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
    try { rmSync(bareDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
