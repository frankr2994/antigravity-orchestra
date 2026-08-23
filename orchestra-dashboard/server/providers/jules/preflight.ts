import { git, getGitStatus } from '../../git.js';
import { isOrchestraInternalPath } from '../../projects.js';
import type { CredentialVault } from '../../infrastructure/security/vault.js';
import { JulesApiClient } from './client.js';
import { discoverJulesSource } from './source-discovery.js';
import type { Store } from '../../db.js';
import { resolveJulesApiKey } from './credentials.js';

// ============================================================================
// Google Jules Cloud Dispatch Preflight & Git Branch Safety
// ============================================================================

export interface JulesPreflightContext {
  taskId: string;
  projectRoot: string;
  vault?: CredentialVault;
  julesClient?: JulesApiClient;
  store?: Store;
  projectId?: string;
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
  const cleanTaskId = taskId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  if (!cleanTaskId || !/^[0-9a-f]{40}$/i.test(headSha)) throw new TypeError('Dispatch branches require a task identity and a full 40-character Git SHA.');
  return `orchestra/jules/${cleanTaskId}/${headSha.slice(0, 12).toLowerCase()}`;
}

export async function checkUnpushedCommits(projectRoot: string): Promise<{ unpushedCount: number; hasUpstream: boolean; error?: boolean }> {
  const status = await getGitStatus(projectRoot);
  if (!status.isGit || !status.root) {
    return { unpushedCount: 0, hasUpstream: false };
  }

  if (!status.upstream) {
    return { unpushedCount: 0, hasUpstream: false };
  }

  const result = await git(['rev-list', '--count', '@{upstream}..HEAD'], status.root).catch(() => null);
  if (!result || result.code !== 0) {
    return { unpushedCount: 0, hasUpstream: true, error: true };
  }

  const count = parseInt(result.stdout.trim(), 10);
  return {
    unpushedCount: Number.isNaN(count) ? 0 : count,
    hasUpstream: true,
    error: Number.isNaN(count),
  };
}

export async function createAndPushDispatchBranch(
  projectRoot: string,
  headSha: string,
  dispatchBranch: string
): Promise<{ pushed: boolean; branchName: string; remoteSha?: string; error?: string }> {
  const status = await getGitStatus(projectRoot);
  if (!status.isGit || !status.root) {
    return { pushed: false, branchName: dispatchBranch, error: 'Not a Git repository.' };
  }

  if (!/^[0-9a-f]{40}$/i.test(headSha)) return { pushed: false, branchName: dispatchBranch, error: 'Dispatch requires a full Git commit SHA.' };
  // Publish the exact object without force and without changing the local checkout.
  const pushResult = await git(
    ['push', 'origin', `${headSha}:refs/heads/${dispatchBranch}`],
    status.root,
    60_000
  ).catch((err) => ({ code: 1, stdout: '', stderr: String(err) }));

  if (pushResult.code !== 0) {
    const errorMsg = (pushResult.stderr || pushResult.stdout).trim();
    return {
      pushed: false,
      branchName: dispatchBranch,
      error: `Failed to push dispatch branch '${dispatchBranch}' to origin: ${errorMsg}`,
    };
  }
  const remoteRef = `refs/heads/${dispatchBranch}`;
  const pushRemote = await git(['remote', 'get-url', '--push', 'origin'], status.root, 10_000).catch(() => null);
  if (!pushRemote || pushRemote.code !== 0 || !pushRemote.stdout.trim()) {
    return { pushed: false, branchName: dispatchBranch, error: 'The origin push destination could not be resolved for verification.' };
  }
  const verify = await git(['ls-remote', '--heads', pushRemote.stdout.trim(), remoteRef], status.root, 30_000)
    .catch((err) => ({ code: 1, stdout: '', stderr: String(err) }));
  const advertised = verify.code === 0
    ? verify.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === remoteRef)?.[0]
    : undefined;
  if (!advertised || advertised.toLowerCase() !== headSha.toLowerCase()) {
    return { pushed: false, branchName: dispatchBranch, remoteSha: advertised, error: 'The dispatch branch could not be verified at the exact local commit.' };
  }
  return { pushed: true, branchName: dispatchBranch, remoteSha: advertised };
}

export async function runJulesPreflight(context: JulesPreflightContext): Promise<JulesPreflightResult> {
  const { taskId, projectRoot, vault, julesClient, store, projectId } = context;

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
  if (unpushed.error) return { ok: false, reason: 'Git could not verify whether the active branch is fully pushed.', resolution: 'Repair the upstream tracking configuration and retry.' };

  if (unpushed.unpushedCount > 0) {
    return {
      ok: false,
      reason: `Active branch '${targetBranch}' has ${unpushed.unpushedCount} unpushed commit(s).`,
      resolution: `Push your commits with \`git push origin ${targetBranch}\` so Google Jules has access to the latest code.`,
    };
  }
  if (gitStatus.upstream !== `origin/${targetBranch}`) {
    return { ok: false, reason: `Active branch '${targetBranch}' must track 'origin/${targetBranch}' for Jules dispatch.`, resolution: 'Set the intended origin upstream and retry.' };
  }
  const pushUrl = await git(['remote', 'get-url', '--push', 'origin'], gitStatus.root);
  const targetRemote = pushUrl.code === 0 ? await git(['ls-remote', '--heads', pushUrl.stdout.trim(), `refs/heads/${targetBranch}`], gitStatus.root, 30_000) : null;
  const targetRemoteSha = targetRemote?.code === 0 ? targetRemote.stdout.trim().split(/\s+/)[0] : undefined;
  if (!targetRemoteSha || targetRemoteSha.toLowerCase() !== headSha.toLowerCase()) {
    return { ok: false, reason: 'The origin target branch does not resolve to the exact local HEAD.', resolution: 'Fetch, resolve any divergence, and push the intended target branch before dispatch.' };
  }

  // 5. Discover matching Jules source resource
  const discovery = await discoverJulesSource(projectRoot, { vault, julesClient, startingBranch: targetBranch });
  if (discovery.status !== 'connected' || !discovery.sourceName) {
    return {
      ok: false,
      reason: `Jules source preflight check failed: ${discovery.diagnostic}`,
      resolution: discovery.resolution,
    };
  }
  // 6. Generate immutable dispatch branch name
  const dispatchBranch = generateDispatchBranchName(taskId, headSha);

  // 7. Serialize repository mutation and verify the exact remote ref after publishing.
  const lease = store?.manager.leases.acquire('git_repository', gitStatus.root, taskId, 120_000);
  if (store && !lease) return { ok: false, reason: 'Another workflow currently owns this repository.', resolution: 'Retry after the active repository operation completes.' };
  let pushResult: Awaited<ReturnType<typeof createAndPushDispatchBranch>>;
  try {
    pushResult = await createAndPushDispatchBranch(projectRoot, headSha, dispatchBranch);
    if (store && lease) store.manager.leases.assertFence('git_repository', gitStatus.root, taskId, lease.fencingToken);
  } finally {
    if (store && lease) store.manager.leases.release('git_repository', gitStatus.root, taskId, lease.fencingToken);
  }
  if (!pushResult.pushed) {
    return {
      ok: false,
      reason: pushResult.error || 'Failed to push dispatch branch to remote origin.',
      resolution: 'Verify your Git credentials have write/push permissions to the remote repository.',
    };
  }
  store?.manager.managedGitResources.register({ taskId, repositoryRoot: gitStatus.root, kind: 'dispatch_ref', resourceValue: dispatchBranch });

  let sourceClient = julesClient;
  if (!sourceClient) {
    const { apiKey } = resolveJulesApiKey(vault);
    if (apiKey) sourceClient = new JulesApiClient({ apiKey, timeoutMs: 15_000 });
  }
  let branchVisible = false;
  if (sourceClient) {
    for (let attempt = 0; attempt < 4 && !branchVisible; attempt += 1) {
      try {
        const source = await sourceClient.getSource(discovery.sourceName);
        const branches = source.githubRepo?.branches?.map((branch) => branch.displayName) ?? [];
        branchVisible = branches.includes(dispatchBranch);
      } catch { break; }
      if (!branchVisible && attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * (2 ** attempt)));
    }
  }
  if (!branchVisible) {
    store?.manager.managedGitResources.scheduleTaskCleanup(taskId);
    return { ok: false, reason: 'Jules did not advertise the exact dispatch branch after it was published.', resolution: 'Refresh the Jules GitHub source and retry after branch propagation completes.' };
  }
  if (store && projectId && discovery.githubOwner && discovery.githubRepo) {
    store.manager.julesSourceMappings.upsert({ projectId, sourceName: discovery.sourceName,
      githubOwner: discovery.githubOwner, githubRepo: discovery.githubRepo, startingBranch: dispatchBranch, targetBranch });
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
