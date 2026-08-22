import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { git } from '../dist-server/git.js';
import {
  generateDispatchBranchName,
  checkUnpushedCommits,
  runJulesPreflight,
} from '../dist-server/providers/jules/preflight.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';

// ============================================================================
// Phase 9 Jules Cloud Dispatch Preflight & Branch Safety Test Suite
// ============================================================================

test('Phase 9 Preflight — generateDispatchBranchName creates safe immutable branch names', () => {
  const branch1 = generateDispatchBranchName('task-12345678-abcd', '7574a1f99999999');
  assert.equal(branch1, 'orchestra/jules-base/task1234-7574a1f');

  const branch2 = generateDispatchBranchName('0000-abcd', 'e3d9bfc');
  assert.equal(branch2, 'orchestra/jules-base/0000abcd-e3d9bfc');
});

test('Phase 9 Preflight — runJulesPreflight detects uncommitted dirty files in project', async () => {
  const fixtureDir = join(tmpdir(), `orchestra-git-dirty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    // Initialize clean git repository
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    await git(['commit', '--allow-empty', '-m', 'Initial commit'], fixtureDir);
    await git(['branch', '-M', 'main'], fixtureDir);
    await git(['remote', 'add', 'origin', 'https://github.com/frankr2994/antigravity-orchestra.git'], fixtureDir);
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], fixtureDir);
    await git(['config', 'branch.main.remote', 'origin'], fixtureDir);
    await git(['config', 'branch.main.merge', 'refs/heads/main'], fixtureDir);

    // Add uncommitted file
    writeFileSync(join(fixtureDir, 'uncommitted.txt'), 'dirty worktree content');

    const result = await runJulesPreflight({
      taskId: 'task-dirty-1',
      projectRoot: fixtureDir,
      skipPush: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason || '', /uncommitted file/i);
    assert.match(result.resolution || '', /Commit or stash/i);
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 9 Preflight — runJulesPreflight succeeds on clean repository with connected source', async () => {
  const fixtureDir = join(tmpdir(), `orchestra-git-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    // Initialize clean git repository
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    await git(['commit', '--allow-empty', '-m', 'Initial commit'], fixtureDir);
    await git(['branch', '-M', 'main'], fixtureDir);
    await git(['remote', 'add', 'origin', 'https://github.com/frankr2994/antigravity-orchestra.git'], fixtureDir);
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], fixtureDir);
    await git(['config', 'branch.main.remote', 'origin'], fixtureDir);
    await git(['config', 'branch.main.merge', 'refs/heads/main'], fixtureDir);

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sources: [
          {
            name: 'sources/github/frankr2994/antigravity-orchestra',
            githubRepo: { owner: 'frankr2994', repo: 'antigravity-orchestra' },
          },
        ],
      }),
    });

    const julesClient = new JulesApiClient({
      apiKey: 'test-key',
      fetchFn: mockFetch,
    });

    const result = await runJulesPreflight({
      taskId: 'task-cloud-12345678',
      projectRoot: fixtureDir,
      julesClient,
      skipPush: true,
    });

    assert.equal(result.ok, true, `Expected preflight to succeed, but failed with: ${result.reason}`);
    assert.equal(result.sourceName, 'sources/github/frankr2994/antigravity-orchestra');
    assert.equal(result.targetBranch, 'main');
    assert.ok(result.dispatchBranch?.startsWith('orchestra/jules-base/taskclou-'));
    assert.ok(result.baseSha);
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 9 Preflight — checkUnpushedCommits inspects repository upstream status', async () => {
  const unpushed = await checkUnpushedCommits(process.cwd());
  assert.equal(typeof unpushed.unpushedCount, 'number');
  assert.equal(typeof unpushed.hasUpstream, 'boolean');
});
