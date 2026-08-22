import { git, getGitStatus } from '../../git.js';
import { isOrchestraInternalPath } from '../../projects.js';
import type { CredentialVault } from '../../infrastructure/security/vault.js';
import type { JulesApiClient } from './client.js';
import { discoverJulesSource } from './source-discovery.js';

// ============================================================================
// Google Jules Cloud Dispatch Preflight & Git Branch Safety
// ============================================================================

export interface JulesPreflightContext {
  taskId: string;
  projectRoot: string;
  vault?: CredentialVault;
  julesClient?: JulesApiClient;
  skipPush?: boolean; // For dry-run tests
}

export interface JulesPreflightResult {
  ok: boolean;
  reason?: string;
  sourceName?: string;
  baseSha?: string;
  dispatchBranch?: string;
  targetBranch?: string;
  diagnostic?: string;
  resolution?: string;
}

export function generateDispatchBranchName(taskId: string, headSha: string): string {
  const cleanTaskId = taskId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const cleanSha = headSha.slice(0, 7);
  return `orchestra/jules-base/${cleanTaskId}-${cleanSha}`;
}

export async function checkUnpushedCommits(projectRoot: string): Promise<{ unpushedCount: number; hasUpstream: boolean }> {
  const status = await getGitStatus(projectRoot);
  if (!status.isGit || !status.root) {
    return { unpushedCount: 0, hasUpstream: false };
  }

  if (!status.upstream) {
    return { unpushedCount: 0, hasUpstream: false };
  }

  const result = await git(['rev-list', '--count', '@{upstream}..HEAD'], status.root).catch(() => null);
  if (!result || result.code !== 0) {
    return { unpushedCount: 0, hasUpstream: true };
  }

  const count = parseInt(result.stdout.trim(), 10);
  return {
    unpushedCount: Number.isNaN(count) ? 0 : count,
    hasUpstream: true,
  };
}

export async function createAndPushDispatchBranch(
  projectRoot: string,
  headSha: string,
  dispatchBranch: string
): Promise<{ pushed: boolean; branchName: string; error?: string }> {
  const status = await getGitStatus(projectRoot);
  if (!status.isGit || !status.root) {
    return { pushed: false, branchName: dispatchBranch, error: 'Not a Git repository.' };
  }

  // Push local headSha directly to remote ref without checking out branch locally
  // git push origin <headSha>:refs/heads/<dispatchBranch>
  const pushResult = await git(
    ['push', 'origin', `${headSha}:refs/heads/${dispatchBranch}`],
    status.root,
    60_000
  ).catch((err) => ({ code: 1, stdout: '', stderr: String(err) }));

  if (pushResult.code !== 0) {
    const errorMsg = (pushResult.stderr || pushResult.stdout).trim();
    // If the remote branch already exists with the exact same commit, it's considered successfully ready
    if (/up-to-date|Everything up-to-date/i.test(errorMsg)) {
      return { pushed: true, branchName: dispatchBranch };
    }
    return {
      pushed: false,
      branchName: dispatchBranch,
      error: `Failed to push dispatch branch '${dispatchBranch}' to origin: ${errorMsg}`,
    };
  }

  return { pushed: true, branchName: dispatchBranch };
}

export async function runJulesPreflight(context: JulesPreflightContext): Promise<JulesPreflightResult> {
  const { taskId, projectRoot, vault, julesClient, skipPush } = context;

  // 1. Verify project is a Git repository
  const gitStatus = await getGitStatus(projectRoot);
  if (!gitStatus.isGit || !gitStatus.root) {
    return {
      ok: false,
      reason: 'The selected project is not a Git repository. Initialize Git before dispatching cloud tasks.',
      resolution: 'Initialize Git in your project folder with `git init` and commit your base files.',
    };
  }

  // 2. Verify active branch and non-detached HEAD
  if (!gitStatus.branch || !gitStatus.head) {
    return {
      ok: false,
      reason: 'Cannot dispatch cloud task from a detached HEAD or unborn branch state.',
      resolution: 'Check out a named branch (e.g. `git checkout main`) and ensure at least one commit exists.',
    };
  }

  const targetBranch = gitStatus.branch;
  const headSha = gitStatus.head;

  // 3. Verify clean working tree (excluding .orchestra internal state)
  const modifiedFiles = gitStatus.files.filter((f) => !isOrchestraInternalPath(f.path));
  if (modifiedFiles.length > 0) {
    return {
      ok: false,
      reason: `Working tree has ${modifiedFiles.length} uncommitted file(s). Cloud execution requires a clean working tree so base commits match remote state.`,
      resolution: 'Commit or stash your uncommitted changes, or run this task locally with Antigravity.',
    };
  }

  // 4. Verify local HEAD is pushed to upstream
  const unpushed = await checkUnpushedCommits(projectRoot);
  if (!unpushed.hasUpstream) {
    return {
      ok: false,
      reason: `Active branch '${targetBranch}' has no upstream remote tracking branch.`,
      resolution: `Push your branch to origin with \`git push -u origin ${targetBranch}\` before dispatching to Jules.`,
    };
  }

  if (unpushed.unpushedCount > 0) {
    return {
      ok: false,
      reason: `Active branch '${targetBranch}' has ${unpushed.unpushedCount} unpushed commit(s).`,
      resolution: `Push your commits with \`git push origin ${targetBranch}\` so Google Jules has access to the latest code.`,
    };
  }

  // 5. Discover matching Jules source resource
  const discovery = await discoverJulesSource(projectRoot, { vault, julesClient });
  if (discovery.status !== 'connected' || !discovery.sourceName) {
    return {
      ok: false,
      reason: `Jules source preflight check failed: ${discovery.diagnostic}`,
      resolution: discovery.resolution,
    };
  }

  // 6. Generate immutable dispatch branch name
  const dispatchBranch = generateDispatchBranchName(taskId, headSha);

  // 7. Push immutable dispatch branch to remote origin
  if (!skipPush) {
    const pushResult = await createAndPushDispatchBranch(projectRoot, headSha, dispatchBranch);
    if (!pushResult.pushed) {
      return {
        ok: false,
        reason: pushResult.error || 'Failed to push dispatch branch to remote origin.',
        resolution: 'Verify your Git credentials have write/push permissions to the remote repository.',
      };
    }
  }

  return {
    ok: true,
    sourceName: discovery.sourceName,
    baseSha: headSha,
    dispatchBranch,
    targetBranch,
    diagnostic: `Preflight passed. Ready to dispatch task '${taskId}' on immutable branch '${dispatchBranch}'.`,
  };
}
