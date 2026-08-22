import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { git } from '../dist-server/git.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';
import {
  generateDispatchBranchName,
  runJulesPreflight,
  checkUnpushedCommits,
} from '../dist-server/providers/jules/preflight.js';

// ============================================================================
// Phase 9 Git & Preflight Verification Test Suite
// ============================================================================

test('Phase 9 Preflight — generateDispatchBranchName creates safe immutable branch names', () => {
  const taskId = 'task-uuid-1234-5678-90ab';
  const headSha = 'abc1234567890abcdef1234567890abcdef123456';
  const branch = generateDispatchBranchName(taskId, headSha);

  assert.ok(branch.startsWith('orchestra/jules-base/taskuuid-'));
  assert.ok(branch.includes('-abc1234'));
  assert.equal(branch.length <= 60, true);
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
    });

    assert.equal(result.ok, false);
    assert.match(result.reason || '', /uncommitted file/i);
    assert.match(result.resolution || '', /Commit or stash/i);
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 9 Preflight — runJulesPreflight succeeds on clean repository with connected source and real push', async () => {
  const fixtureDir = join(tmpdir(), `orchestra-git-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const bareDir = join(tmpdir(), `orchestra-git-bare-${Date.now()}-${Math.random().toString(36).slice(2)}.git`);
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(bareDir, { recursive: true });

  try {
    // Initialize bare remote
    await git(['init', '--bare'], bareDir);

    // Initialize clean git repository
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    writeFileSync(join(fixtureDir, 'README.md'), '# Clean Repo Test');
    await git(['add', 'README.md'], fixtureDir);
    await git(['commit', '-m', 'Initial commit'], fixtureDir);
    await git(['branch', '-M', 'main'], fixtureDir);

    // Configure remote with push URL pointing to local bare repository
    await git(['remote', 'add', 'origin', 'https://github.com/frankr2994/antigravity-orchestra.git'], fixtureDir);
    await git(['remote', 'set-url', '--push', 'origin', bareDir], fixtureDir);
    await git(['push', '-u', 'origin', 'main'], fixtureDir);

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
    });

    assert.equal(result.ok, true, `Expected preflight to succeed, but failed with: ${result.reason}`);
    assert.equal(result.sourceName, 'sources/github/frankr2994/antigravity-orchestra');
    assert.equal(result.targetBranch, 'main');
    assert.ok(result.dispatchBranch?.startsWith('orchestra/jules-base/taskclou-'));
    assert.ok(result.baseSha);
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
    try { rmSync(bareDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 9 Preflight — checkUnpushedCommits inspects repository upstream status', async () => {
  const fixtureDir = join(tmpdir(), `orchestra-git-unpushed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureDir, { recursive: true });

  try {
    await git(['init'], fixtureDir);
    await git(['config', 'user.name', 'Orchestra Test'], fixtureDir);
    await git(['config', 'user.email', 'test@orchestra.local'], fixtureDir);
    await git(['commit', '--allow-empty', '-m', 'Initial commit'], fixtureDir);
    await git(['branch', '-M', 'main'], fixtureDir);

    const unpushed = await checkUnpushedCommits(fixtureDir, 'main');
    assert.equal(typeof unpushed.hasUpstream, 'boolean');
    assert.equal(typeof unpushed.unpushedCount, 'number');
  } finally {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
  }
});
