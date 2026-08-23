import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { git, getGitStatus } from '../../git.js';
import { verifyProject, type VerificationResult } from '../../verification.js';
import { config } from '../../config.js';

// ============================================================================
// Google Jules Worktree-Isolated Pull Request Review Engine
// ============================================================================

export interface WorktreeReviewOptions {
  taskId: string;
  projectRoot: string;
  baseSha: string;
  headSha?: string;
  headBranch?: string;
  prNumber?: number;
  skipFetch?: boolean;
  skipVerification?: boolean;
  signal?: AbortSignal;
}

export interface WorktreeReviewResult {
  ok: boolean;
  headSha: string;
  baseSha: string;
  diff: string;
  changedFiles: string[];
  verificationResults: VerificationResult[];
  verified: boolean;
  error?: string;
}

export function getWorktreePath(projectRoot: string, taskId: string): string {
  const cleanTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!cleanTaskId) throw new TypeError('A stable task identity is required for a managed worktree.');
  const repository = createHash('sha256').update(resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 16);
  return join(config.dataDir, 'review-worktrees', repository, cleanTaskId);
}

function assertManagedWorktreePath(path: string): void {
  const base = resolve(config.dataDir, 'review-worktrees'); const target = resolve(path); const child = relative(base, target);
  if (!child || child.startsWith('..') || resolve(base, child) !== target) throw new Error('Refusing to modify an unmanaged worktree path.');
}

export async function fetchPullRequestRef(
  projectRoot: string,
  options: { prNumber?: number; headBranch?: string; headSha?: string }
): Promise<{ fetched: boolean; ref?: string; error?: string }> {
  const status = await getGitStatus(projectRoot);
  if (!status.isGit || !status.root) {
    return { fetched: false, error: 'Project is not a Git repository.' };
  }

  const { prNumber, headBranch, headSha } = options;

  // 1. Fetch by PR number: refs/pull/<pr>/head
  if (prNumber) {
    const refSpec = `+refs/pull/${prNumber}/head:refs/remotes/origin/pr/${prNumber}`;
    const result = await git(['fetch', 'origin', refSpec], status.root, 60_000).catch((err) => ({
      code: 1,
      stdout: '',
      stderr: String(err),
    }));
    if (result.code !== 0) {
      return {
        fetched: false,
        error: `Failed to fetch PR #${prNumber} from origin: ${(result.stderr || result.stdout).trim()}`,
      };
    }
    return { fetched: true, ref: `refs/remotes/origin/pr/${prNumber}` };
  }

  // 2. Fetch by head branch name
  if (headBranch) {
    const refSpec = `+refs/heads/${headBranch}:refs/remotes/origin/${headBranch}`;
    const result = await git(['fetch', 'origin', refSpec], status.root, 60_000).catch((err) => ({
      code: 1,
      stdout: '',
      stderr: String(err),
    }));
    if (result.code !== 0) {
      return {
        fetched: false,
        error: `Failed to fetch branch '${headBranch}' from origin: ${(result.stderr || result.stdout).trim()}`,
      };
    }
    return { fetched: true, ref: `refs/remotes/origin/${headBranch}` };
  }

  // 3. Fetch specific commit SHA
  if (headSha) {
    const result = await git(['fetch', 'origin', headSha], status.root, 60_000).catch((err) => ({
      code: 1,
      stdout: '',
      stderr: String(err),
    }));
    if (result.code !== 0) {
      return {
        fetched: false,
        error: `Failed to fetch commit SHA '${headSha}' from origin: ${(result.stderr || result.stdout).trim()}`,
      };
    }
    return { fetched: true, ref: headSha };
  }

  return { fetched: false, error: 'No PR number, head branch, or head SHA specified for fetch.' };
}

export async function createIsolatedWorktree(
  projectRoot: string,
  taskId: string,
  commitShaOrRef: string
): Promise<string> {
  const worktreePath = getWorktreePath(projectRoot, taskId);
  assertManagedWorktreePath(worktreePath);
  mkdirSync(dirname(worktreePath), { recursive: true });

  // If a worktree already exists at this path, remove it cleanly first
  if (existsSync(worktreePath)) {
    await git(['worktree', 'remove', '--force', worktreePath], projectRoot).catch(() => null);
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const result = await git(['worktree', 'add', '--detach', worktreePath, commitShaOrRef], projectRoot);
  if (result.code !== 0) {
    throw new Error(`Failed to create isolated Git worktree: ${(result.stderr || result.stdout).trim()}`);
  }

  return worktreePath;
}

export async function cleanupIsolatedWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  assertManagedWorktreePath(worktreePath);
  await git(['worktree', 'remove', '--force', worktreePath], projectRoot).catch(() => null);
  await git(['worktree', 'prune'], projectRoot).catch(() => null);
  for (let attempt = 0; existsSync(worktreePath) && attempt < 3; attempt += 1) {
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* retry expected Windows locks */ }
    if (existsSync(worktreePath)) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50 * (attempt + 1)));
  }
  if (existsSync(worktreePath)) throw new Error('Managed worktree cleanup remains pending because files are locked.');
}

export async function runWorktreeReview(options: WorktreeReviewOptions): Promise<WorktreeReviewResult> {
  const { taskId, projectRoot, baseSha, headSha, headBranch, prNumber, skipFetch, skipVerification, signal } = options;

  let resolvedHeadSha = headSha || '';
  let worktreePath: string | null = null;

  try {
    if (!/^[0-9a-f]{40}$/i.test(baseSha) || (headSha && !/^[0-9a-f]{40}$/i.test(headSha))) {
      throw new Error('Worktree review requires exact full Git commit identities.');
    }
    // 1. Fetch remote ref if not skipped
    if (!skipFetch) {
      const fetchRes = await fetchPullRequestRef(projectRoot, { prNumber, headBranch, headSha });
      if (!fetchRes.fetched) {
        return {
          ok: false,
          headSha: resolvedHeadSha,
          baseSha,
          diff: '',
          changedFiles: [],
          verificationResults: [],
          verified: false,
          error: fetchRes.error,
        };
      }
      if (!resolvedHeadSha && fetchRes.ref) {
        const revResult = await git(['rev-parse', fetchRes.ref], projectRoot);
        if (revResult.code === 0) {
          resolvedHeadSha = revResult.stdout.trim();
        }
      }
    }

    if (!resolvedHeadSha) {
      const revResult = await git(['rev-parse', 'HEAD'], projectRoot);
      resolvedHeadSha = revResult.stdout.trim();
    }

    // 2. Create isolated worktree
    worktreePath = await createIsolatedWorktree(projectRoot, taskId, resolvedHeadSha);
    const checkedOut = await git(['rev-parse', '--verify', 'HEAD^{commit}'], worktreePath);
    if (checkedOut.code !== 0 || checkedOut.stdout.trim().toLowerCase() !== resolvedHeadSha.toLowerCase()) {
      throw new Error('The isolated worktree did not resolve to the requested review commit.');
    }

    // 3. Compute exact diff between baseSha and worktree HEAD
    const [diffResult, nameOnlyResult] = await Promise.all([
      git(['diff', '--no-ext-diff', `${baseSha}...HEAD`], worktreePath),
      git(['diff', '--name-only', `${baseSha}...HEAD`], worktreePath),
    ]);

    const diff = diffResult.stdout;
    const changedFiles = nameOnlyResult.stdout
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter(Boolean);
    if (diff.length >= 1_900_000 || changedFiles.length > 1_000) {
      throw new Error('The pull request exceeds the bounded local review limits.');
    }

    // 4. Run project verification within worktree
    let verificationResults: VerificationResult[] = [];
    let verified = true;

    if (!skipVerification) {
      const abortSignal = signal ?? new AbortController().signal;
      verificationResults = await verifyProject(worktreePath, abortSignal);
      verified = verificationResults.length > 0 && verificationResults.every((r) => r.code === 0);
    }

    return {
      ok: true,
      headSha: resolvedHeadSha,
      baseSha,
      diff,
      changedFiles,
      verificationResults,
      verified,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      headSha: resolvedHeadSha,
      baseSha,
      diff: '',
      changedFiles: [],
      verificationResults: [],
      verified: false,
      error: message,
    };
  } finally {
    // 5. Guaranteed cleanup of isolated worktree
    if (worktreePath) {
      // Cleanup failure must replace a misleading successful review result.
      await cleanupIsolatedWorktree(projectRoot, worktreePath);
    }
  }
}
