import { git, getGitStatus } from '../../git.js';
import { verifyProject, type VerificationResult } from '../../verification.js';
import { cleanupManagedWorktree, createManagedWorktree, getManagedWorktreePath } from '../../infrastructure/git/managed-worktree.js';

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
  return getManagedWorktreePath(projectRoot, taskId);
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
  return createManagedWorktree(projectRoot, taskId, commitShaOrRef);
}

export async function cleanupIsolatedWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  return cleanupManagedWorktree(projectRoot, worktreePath);
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
