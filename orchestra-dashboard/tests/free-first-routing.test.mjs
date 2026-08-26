import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decideFreeFirstRoute, isGemmaMicroEditCandidate } from '../dist-server/domain/index.js';
import { GemmaMicroEditService } from '../dist-server/application/gemma/micro-edit-service.js';
import { createIsolatedWorktree, cleanupIsolatedWorktree } from '../dist-server/providers/jules/worktree-review.js';
import { git, getGitStatus } from '../dist-server/git.js';

const classification = (overrides = {}) => ({ type: 'implementation', mutating: true, complexity: 'normal', riskFlags: [], codexRole: 'none', title: 'task', ...overrides });

test('free-first policy reserves small safe changes for Gemma and standard work for Jules', () => {
  assert.equal(decideFreeFirstRoute(classification({ type: 'question', mutating: false, complexity: 'small' }), 'Explain this', { julesReady: true }).worker, 'gemma');
  assert.equal(decideFreeFirstRoute(classification({ complexity: 'small' }), 'Change one label', { julesReady: true }).worker, 'gemma');
  assert.equal(decideFreeFirstRoute(classification(), 'Implement the feature', { julesReady: true }).worker, 'jules');
  assert.equal(decideFreeFirstRoute(classification(), 'Implement the feature', { julesReady: false, julesReason: 'Capacity full.' }).worker, 'antigravity');
  assert.equal(isGemmaMicroEditCandidate(classification({ complexity: 'small' }), 'Change authentication middleware'), false);
});

test('bounded Gemma micro-edit verifies in a worktree before applying to the main worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-gemma-edit-'));
  try {
    await git(['init'], root);
    await git(['config', 'user.name', 'Orchestra Test'], root);
    await git(['config', 'user.email', 'test@orchestra.local'], root);
    writeFileSync(join(root, 'message.txt'), 'before\n');
    await git(['add', '.'], root); await git(['commit', '-m', 'baseline'], root);
    const base = (await getGitStatus(root)).head;
    const service = new GemmaMicroEditService({
      generate: async ({ root: worktree }) => { writeFileSync(join(worktree, 'message.txt'), 'after\n'); return { success: true, result: 'Changed the message.', changedFiles: ['message.txt'] }; },
      verify: async () => [{ command: 'test', code: 0, output: 'passed' }],
      createWorktree: createIsolatedWorktree,
      cleanupWorktree: cleanupIsolatedWorktree,
    });
    const result = await service.attempt({ taskId: `safe-${Date.now()}`, projectRoot: root, baseSha: base, prompt: 'Change the message', signal: new AbortController().signal });
    assert.equal(result.applied, true);
    assert.deepEqual(result.changedFiles, ['message.txt']);
    assert.equal(readFileSync(join(root, 'message.txt'), 'utf8').replaceAll('\r\n', '\n'), 'after\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('oversized Gemma candidate is discarded without touching the main worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-gemma-limit-'));
  try {
    await git(['init'], root);
    await git(['config', 'user.name', 'Orchestra Test'], root);
    await git(['config', 'user.email', 'test@orchestra.local'], root);
    writeFileSync(join(root, 'message.txt'), 'before\n');
    await git(['add', '.'], root); await git(['commit', '-m', 'baseline'], root);
    const base = (await getGitStatus(root)).head;
    const service = new GemmaMicroEditService({
      generate: async ({ root: worktree }) => { writeFileSync(join(worktree, 'message.txt'), Array.from({ length: 250 }, (_, index) => `line ${index}`).join('\n')); return { success: true, result: 'Large rewrite.', changedFiles: ['message.txt'] }; },
      verify: async () => [{ command: 'test', code: 0, output: 'passed' }],
      createWorktree: createIsolatedWorktree,
      cleanupWorktree: cleanupIsolatedWorktree,
    });
    const result = await service.attempt({ taskId: `large-${Date.now()}`, projectRoot: root, baseSha: base, prompt: 'Change the message', signal: new AbortController().signal });
    assert.equal(result.applied, false);
    assert.match(result.reason, /exceeded the micro-edit gate/i);
    assert.equal(readFileSync(join(root, 'message.txt'), 'utf8'), 'before\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
