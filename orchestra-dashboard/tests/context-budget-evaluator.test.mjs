import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContextBudget, estimateTokens } from '../dist-server/application/context/context-budget-evaluator.js';

test('Context Budget Evaluator — token estimation', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('Hello world') >= 3);
  assert.ok(estimateTokens('a'.repeat(360)) >= 100);
});

test('Context Budget Evaluator — fits in local context chooses Local Gemma', () => {
  const result = evaluateContextBudget({
    prompt: 'Fix the typo in header title',
    capabilities: {
      gemma: { available: true, modelId: 'gemma-4-12b', contextLength: 8192 },
      codex: { rollingQuotaRemaining: 80, weeklyQuotaRemaining: 90, models: ['gpt-5.6-terra', 'gpt-5.6-luna'] },
      antigravity: { available: true, models: ['gemini-3.7-flash'] },
      jules: { available: false, readyForProject: false },
      mcp: { rider: false, operationalCount: 0 },
    },
  });

  assert.equal(result.exceedsLocalCapacity, false);
  assert.equal(result.recommendedRefiner, 'local-gemma');
  assert.ok(result.reason.includes('0 cloud tokens'));
});

test('Context Budget Evaluator — large prompt/overview promotes to Codex Luna High', () => {
  const largePrompt = 'Detailed feature spec: '.repeat(2000); // ~96KB text (~26k tokens)
  const result = evaluateContextBudget({
    prompt: largePrompt,
    capabilities: {
      gemma: { available: true, modelId: 'gemma-4-12b', contextLength: 8192 },
      codex: { rollingQuotaRemaining: 80, weeklyQuotaRemaining: 90, models: ['gpt-5.6-terra', 'gpt-5.6-luna'] },
      antigravity: { available: true, models: ['gemini-3.7-flash'] },
      jules: { available: false, readyForProject: false },
      mcp: { rider: false, operationalCount: 0 },
    },
  });

  assert.equal(result.exceedsLocalCapacity, true);
  assert.equal(result.recommendedRefiner, 'codex-luna');
  assert.ok(result.reason.includes('promoted to Codex Luna High'));
});

test('Context Budget Evaluator — LM Studio offline promotes to Codex Luna High', () => {
  const result = evaluateContextBudget({
    prompt: 'Small fix',
    capabilities: {
      gemma: { available: false, modelId: null, contextLength: 8192 },
      codex: { rollingQuotaRemaining: 80, weeklyQuotaRemaining: 90, models: ['gpt-5.6-terra', 'gpt-5.6-luna'] },
      antigravity: { available: true, models: ['gemini-3.7-flash'] },
      jules: { available: false, readyForProject: false },
      mcp: { rider: false, operationalCount: 0 },
    },
  });

  assert.equal(result.exceedsLocalCapacity, true);
  assert.equal(result.recommendedRefiner, 'codex-luna');
});
