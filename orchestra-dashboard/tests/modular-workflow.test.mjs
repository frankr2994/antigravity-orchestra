import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { buildReviewPromptEnvelope } from '../dist-server/application/context/review-prompt-envelope.js';

test('workspace reducer starts a genuinely blank conversation without losing project ownership', async () => {
  const { initialWorkspaceState, workspaceReducer } = await tsImport('../src/app/workspace-state.ts', import.meta.url);
  const owner = { id: 'task-owner' };
  const prior = {
    ...initialWorkspaceState,
    sessions: [{ id: 'old' }],
    session: { id: 'old' },
    messages: [{ id: 'message' }],
    activeTask: { id: 'active' },
    projectOwnerTask: owner,
    activity: [{ id: 1 }],
  };
  const next = workspaceReducer(prior, { type: 'new-conversation', session: { id: 'new' } });
  assert.equal(next.session.id, 'new');
  assert.deepEqual(next.messages, []);
  assert.equal(next.activeTask, null);
  assert.deepEqual(next.activity, []);
  assert.equal(next.projectOwnerTask, owner);
  assert.deepEqual(next.sessions.map((session) => session.id), ['new', 'old']);
});

test('review envelope is bounded, fingerprinted, and reports compaction', () => {
  const envelope = buildReviewPromptEnvelope({
    request: 'review this change',
    changedFiles: Array.from({ length: 200 }, (_, index) => `src/file-${index}.ts`),
    triage: 'triage '.repeat(2_000),
    implementationSummary: 'summary '.repeat(2_000),
    previousReview: 'finding '.repeat(2_000),
    diff: '+changed\n'.repeat(20_000),
  });
  assert.ok(envelope.text.length <= 48_000);
  assert.match(envelope.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(envelope.estimatedInputTokens, Math.ceil(envelope.text.length / 2));
  assert.equal(envelope.compacted, true);
  assert.equal(envelope.purpose, 'repair-review');
  assert.match(envelope.text, /characters omitted/);
});
