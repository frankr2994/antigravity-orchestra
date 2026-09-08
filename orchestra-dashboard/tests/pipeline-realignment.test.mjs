import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { clampToQuota } from '../dist-server/application/gemma/prompt-refinement-service.js';
import { condenseDiff } from '../dist-server/application/gemma/diff-condenser-service.js';
import { antigravityModelForEffort } from '../dist-server/application/routing/model-policy.js';
import { runBuilderStage } from '../dist-server/application/tasks/pipeline/5-builder-stage.js';
import { runFinalizationStage } from '../dist-server/application/tasks/pipeline/8-finalization-stage.js';
import { Store } from '../dist-server/db.js';

test('clampToQuota downgrades Codex model and effort based on remaining quota', () => {
  const baseRefinement = {
    refinedSpec: 'Implement OEM layout export engine',
    phases: [{ name: 'Phase 1', description: 'SVG exporter', priority: 1 }],
    recommendedCodexModel: 'gpt-5.6-sol',
    recommendedCodexEffort: 'high',
    recommendedAntigravityEffort: 'high',
    routeTarget: 'antigravity',
    reasoning: 'Complex vector layout requires deep planning',
  };

  // Normal quota (> 20%): preserves recommended tiers
  const normal = clampToQuota(baseRefinement, 85);
  assert.equal(normal.recommendedCodexModel, 'gpt-5.6-sol');
  assert.equal(normal.recommendedCodexEffort, 'high');

  // Low quota (15%): clamps sol down to terra/medium
  const moderate = clampToQuota(baseRefinement, 12);
  assert.equal(moderate.recommendedCodexModel, 'gpt-5.6-terra');
  assert.equal(moderate.recommendedCodexEffort, 'medium');

  // Critical quota (<= 5%): clamps to luna/low
  const critical = clampToQuota(baseRefinement, 3.5);
  assert.equal(critical.recommendedCodexModel, 'gpt-5.6-luna');
  assert.equal(critical.recommendedCodexEffort, 'low');
});

test('condenseDiff deterministically strips lockfiles, minified bundles, and build outputs from the diff', async () => {
  const mockDiff = [
    'diff --git a/package-lock.json b/package-lock.json',
    'index 1234567..89abcdef 100644',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1,5 +1,5 @@',
    '+  "version": "1.0.9",',
    'diff --git a/src/components/SchematicView.tsx b/src/components/SchematicView.tsx',
    'index abcdef1..2345678 100644',
    '--- a/src/components/SchematicView.tsx',
    '+++ b/src/components/SchematicView.tsx',
    '@@ -10,6 +10,12 @@',
    '+export function ExportButton() {',
    '+  return <button>Export OEM Schematic</button>;',
    '+}',
    'diff --git a/dist/bundle.min.js b/dist/bundle.min.js',
    'index 0000000..1111111 100644',
    '--- a/dist/bundle.min.js',
    '+++ b/dist/bundle.min.js',
    '@@ -1 +1 @@',
    '+var minified=true;',
  ].join('\n');

  const changedFiles = [
    'package-lock.json',
    'src/components/SchematicView.tsx',
    'dist/bundle.min.js',
  ];

  const result = await condenseDiff({
    diff: mockDiff,
    changedFiles,
    refinedSpec: 'Add OEM schematic export button to SchematicView',
    implementationSummary: 'Added ExportButton component in SchematicView.tsx',
  });

  // Lockfiles and dist files are stripped
  assert.ok(result.strippedPaths.includes('package-lock.json'));
  assert.ok(result.strippedPaths.includes('dist/bundle.min.js'));
  assert.ok(!result.cleanDiff.includes('package-lock.json'));
  assert.ok(!result.cleanDiff.includes('bundle.min.js'));

  // Meaningful code is preserved
  assert.ok(result.cleanDiff.includes('src/components/SchematicView.tsx'));
  assert.ok(result.cleanDiff.includes('ExportButton'));
  assert.equal(result.authoritativeDiff, mockDiff, 'the independent review must retain the complete original diff');
  assert.ok(result.estimatedTokens > 0);
});

function pipelineContext(overrides = {}) {
  const updates = [];
  return {
    taskId: 'parent-task',
    project: { id: 'project-1', root: 'C:/project' },
    session: { id: 'session-1', antigravityConversationId: null },
    task: { prompt: 'Implement the feature' },
    classification: { mutating: true },
    models: { antigravity: 'gemini-high' },
    capabilities: { jules: { readyForProject: true } },
    status: { head: 'a'.repeat(40) },
    signal: new AbortController().signal,
    recovery: false,
    activeGemmaModel: 'gemma',
    antigravityModels: [],
    refinedSpec: 'Implement the feature',
    store: {
      listTasks: () => [],
      listEvents: () => [],
      updateTask: (_id, fields) => updates.push(fields),
    },
    emit: () => {},
    stream: () => {},
    transition: () => {},
    recordProviderTelemetry: () => {},
    recordLocalProviderTelemetry: () => {},
    riderFor: () => false,
    complete: () => {},
    updates,
    ...overrides,
  };
}

test('hybrid builder waits for Jules, then runs Antigravity on the integrated commit', async () => {
  const calls = [];
  const ctx = pipelineContext({
    julesBuilder: {
      dispatchAndWait: async () => {
        calls.push('jules');
        return { taskId: 'child-task', commitSha: 'b'.repeat(40), result: 'Jules integrated foundation work.', requiredLocalRepair: false };
      },
    },
  });
  const agentResult = {
    text: 'Antigravity completed the combined work.', conversationId: null, raw: '', warning: null,
    usage: null, terminalStatus: 'COMPLETED', incomplete: false, failureReason: null, continuationGuidance: null,
  };
  const result = await runBuilderStage({
    ctx, refinedSpec: 'Implement the feature', blueprint: 'Build the foundation then finish locally.',
    builderTarget: 'both', antigravityModel: 'gemini-high', antigravityEffort: 'high',
  }, {
    runAntigravity: async (input) => {
      calls.push('antigravity');
      assert.match(input.context, /Jules integrated foundation work/);
      assert.match(input.context, new RegExp('b{40}'));
      return agentResult;
    },
  });

  assert.deepEqual(calls, ['jules', 'antigravity']);
  assert.equal(result.julesResult.commitSha, 'b'.repeat(40));
  assert.ok(ctx.updates.some((value) => value.commitSha === 'b'.repeat(40) && value.pushStatus === 'pushed'));
});

test('Jules-only builder returns the reviewed cloud result without invoking Antigravity', async () => {
  let antigravityCalled = false;
  const ctx = pipelineContext({
    julesBuilder: { dispatchAndWait: async () => ({ taskId: 'child-task', commitSha: 'c'.repeat(40), result: 'Jules result', requiredLocalRepair: false }) },
  });
  const result = await runBuilderStage({
    ctx, refinedSpec: 'Implement in Jules', blueprint: '', builderTarget: 'jules',
    antigravityModel: 'gemini-high', antigravityEffort: 'high',
  }, { runAntigravity: async () => { antigravityCalled = true; throw new Error('must not run'); } });
  assert.equal(antigravityCalled, false);
  assert.equal(result.agentResult.text, 'Jules result');
});

test('finalization delegates terminal state, messages, and unpushed handling to canonical completion', async () => {
  const completions = [];
  const ctx = pipelineContext({
    complete: (result, agent) => completions.push({ result, agent }),
  });
  const result = await runFinalizationStage(ctx, 'Combined implementation result', false, {
    finalize: async () => ({ status: 'committed', commitSha: 'd'.repeat(40), pushStatus: 'unpushed', branch: 'main' }),
  });
  assert.equal(result.gitResult.pushStatus, 'unpushed');
  assert.deepEqual(completions, [{ result: 'Combined implementation result', agent: 'antigravity' }]);
});

test('hybrid finalization completes parent and adopted Jules child with retryable unpushed state', async () => {
  const dbPath = join(tmpdir(), `orchestra-hybrid-final-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const store = new Store(dbPath);
  try {
    const project = store.upsertProject({ name: 'hybrid', root: 'C:/hybrid-project', gitRoot: 'C:/hybrid-project' });
    const session = store.createSession(project.id, 'Hybrid');
    const parent = store.createTask(project.id, session.id, 'Hybrid parent');
    const child = store.createTask(project.id, session.id, 'Jules child', null, null, 'cloud');
    store.updateTask(parent.id, { state: 'running' });
    store.updateTask(child.id, { state: 'running', target: 'local' });
    store.updateTask(child.id, { state: 'reviewing' });
    store.updateTask(child.id, { state: 'recovery_required', error: 'Local repair required.' });
    const attempt = store.manager.attempts.create({
      taskId: child.id, target: 'local', worker: 'antigravity', baseSha: 'a'.repeat(40), state: 'WORKING',
    });

    const ctx = pipelineContext({
      taskId: parent.id,
      project,
      session,
      task: parent,
      store,
      adoptedJulesTaskId: child.id,
      complete: (result, agent) => {
        const current = store.getTask(parent.id);
        const state = current.pushStatus === 'unpushed' ? 'completed_unpushed' : 'completed';
        store.updateTask(parent.id, { state, result });
        store.addMessage({ sessionId: session.id, taskId: parent.id, role: 'assistant', agent, content: result });
      },
    });
    const result = await runFinalizationStage(ctx, 'Hybrid complete', false, {
      finalize: async () => {
        store.updateTask(parent.id, { state: 'committing', commitSha: 'd'.repeat(40) });
        store.updateTask(parent.id, { state: 'pushing', pushStatus: 'unpushed' });
        return { status: 'committed', commitSha: 'd'.repeat(40), pushStatus: 'unpushed', branch: 'main' };
      },
    });

    assert.equal(result.gitResult.pushStatus, 'unpushed');
    assert.equal(store.getTask(parent.id).state, 'completed_unpushed');
    assert.equal(store.getTask(child.id).state, 'completed_unpushed');
    assert.equal(store.getTask(child.id).commitSha, 'd'.repeat(40));
    assert.equal(store.manager.attempts.getById(attempt.id).state, 'COMPLETED');
    assert.ok(store.listMessages(session.id).some((message) => message.taskId === parent.id && message.content === 'Hybrid complete'));
  } finally {
    store.close();
    try { rmSync(dbPath, { force: true }); } catch { /* SQLite cleanup can lag briefly on Windows. */ }
  }
});

test('antigravityModelForEffort maps reasoning levels to appropriate model tiers', () => {
  assert.equal(antigravityModelForEffort('low'), 'gemini-3.7-flash-low');
  assert.equal(antigravityModelForEffort('medium'), 'gemini-3.7-flash-medium');
  assert.equal(antigravityModelForEffort('high'), 'gemini-3.7-flash-high');
});
