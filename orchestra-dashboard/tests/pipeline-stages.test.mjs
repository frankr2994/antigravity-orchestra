import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToQuota } from '../dist-server/application/gemma/prompt-refinement-service.js';
import { detectContractDrift } from '../dist-server/application/gemma/diff-condenser-service.js';
import { antigravityModelForEffort } from '../dist-server/application/routing/model-policy.js';

test('Pipeline Stages — Contract drift detection flags deleted types and schema edits', () => {
  const diff = `
--- a/src/types.ts
+++ b/src/types.ts
-export interface UserConfig {
-  name: string;
-}
--- a/src/schema.ts
+++ b/src/schema.ts
+export const table = 'users';
--- a/tests/app.test.ts
+++ b/tests/app.test.ts
-  assert.equal(1, 1);
-  expect(val).toBe(true);
`;

  const flags = detectContractDrift(diff);
  assert.ok(flags.some((f) => f.includes('CONTRACT DRIFT')));
  assert.ok(flags.some((f) => f.includes('Database schema')));
  assert.ok(flags.some((f) => f.includes('TEST INTEGRITY')));
});

test('Pipeline Stages — Sizing stage maps low/medium/high efforts accurately', () => {
  assert.equal(antigravityModelForEffort('low'), 'gemini-3.7-flash-low');
  assert.equal(antigravityModelForEffort('medium'), 'gemini-3.7-flash-medium');
  assert.equal(antigravityModelForEffort('high'), 'gemini-3.7-flash-high');
});

test('Pipeline Stages — Prompt refinement clamps model when quota is low', () => {
  const base = {
    refinedSpec: 'Add new feature',
    phases: [{ name: 'Phase 1', description: 'desc', priority: 1 }],
    recommendedCodexModel: 'gpt-5.6-sol',
    recommendedCodexEffort: 'high',
    recommendedAntigravityEffort: 'high',
    routeTarget: 'antigravity',
    reasoning: 'test',
  };

  const clamped5 = clampToQuota(base, 4);
  assert.equal(clamped5.recommendedCodexModel, 'gpt-5.6-luna');
  assert.equal(clamped5.recommendedCodexEffort, 'low');

  const clamped15 = clampToQuota(base, 12);
  assert.equal(clamped15.recommendedCodexModel, 'gpt-5.6-terra');
  assert.equal(clamped15.recommendedCodexEffort, 'medium');

  const unclamped = clampToQuota(base, 90);
  assert.equal(unclamped.recommendedCodexModel, 'gpt-5.6-sol');
  assert.equal(unclamped.recommendedCodexEffort, 'high');
});
