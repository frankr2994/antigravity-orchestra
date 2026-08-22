import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { git } from '../dist-server/git.js';
import {
  getWorktreePath,
  createIsolatedWorktree,
  cleanupIsolatedWorktree,
  runWorktreeReview,
} from '../dist-server/providers/jules/worktree-review.js';

// ============================================================================
// Phase 11 Worktree-Isolated Pull Request Review Engine Test Suite
// ============================================================================

test('Phase 11 Worktree Review — getWorktreePath generates clean isolated paths', () => {
  const path = getWorktreePath('F:/my-repo', 'task-1234-abcd');
  assert.equal(path.replace(/\\/g, '/'), 'F:/my-repo/.orchestra/worktrees/task-1234-abcd');
});

test('Phase 11 Worktree Review — createIsolatedWorktree and cleanupIsolatedWorktree', async () => {
  const fixtureDir = join(tmpdir(), `orchestra-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    // 1. Initialize git repo
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    writeFileSync(join(fixtureDir, 'README.md'), '# Initial Base');
    await git(['add', 'README.md'], fixtureDir);
    await git(['commit', '-m', 'Initial commit'], fixtureDir);
    const baseHead = (await git(['rev-parse', 'HEAD'], fixtureDir)).stdout.trim();

    // 2. Create isolated worktree
    const worktreePath = await createIsolatedWorktree(fixtureDir, 'task-wt-1', baseHead);
    assert.ok(existsSync(worktreePath));
    assert.ok(existsSync(join(worktreePath, 'README.md')));

    // Primary workspace is unchanged
    const currentBranch = (await git(['branch', '--show-current'], fixtureDir)).stdout.trim();
    assert.ok(currentBranch === 'main' || currentBranch === 'master');

    // 3. Cleanup worktree
    await cleanupIsolatedWorktree(fixtureDir, worktreePath);
    assert.ok(!existsSync(worktreePath), 'Worktree directory must be removed after cleanup');
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 11 Worktree Review — runWorktreeReview computes diff and ensures worktree cleanup', async () => {
  const fixtureDir = join(tmpdir(), `orchestra-wt-rev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    // 1. Initial base commit
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    writeFileSync(join(fixtureDir, 'file1.txt'), 'hello base');
    await git(['add', 'file1.txt'], fixtureDir);
    await git(['commit', '-m', 'Initial base commit'], fixtureDir);
    const baseSha = (await git(['rev-parse', 'HEAD'], fixtureDir)).stdout.trim();

    // 2. Secondary commit (simulating cloud worker PR head)
    writeFileSync(join(fixtureDir, 'file2.txt'), 'hello cloud worker');
    await git(['add', 'file2.txt'], fixtureDir);
    await git(['commit', '-m', 'Cloud worker implementation'], fixtureDir);
    const headSha = (await git(['rev-parse', 'HEAD'], fixtureDir)).stdout.trim();

    // 3. Run worktree review
    const result = await runWorktreeReview({
      taskId: 'task-review-test',
      projectRoot: fixtureDir,
      baseSha,
      headSha,
      skipFetch: true,
      skipVerification: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.headSha, headSha);
    assert.equal(result.baseSha, baseSha);
    assert.ok(result.diff.includes('hello cloud worker'));
    assert.deepEqual(result.changedFiles, ['file2.txt']);

    // 4. Verify worktree directory is cleaned up
    const expectedWorktreePath = getWorktreePath(fixtureDir, 'task-review-test');
    assert.ok(!existsSync(expectedWorktreePath), 'Isolated worktree must not persist after review completes');
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
