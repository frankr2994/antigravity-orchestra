import { basename } from 'node:path';
import { runProcess } from './process.js';
import { parseGitHubRepositoryRemote } from './domain/github-repository.js';

export interface GitStatus {
  isGit: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  files: Array<{ path: string; index: string; worktree: string }>;
  dirty: boolean;
}

export async function git(args: string[], cwd: string, timeoutMs = 30_000) {
  return runProcess('git.exe', ['-C', cwd, ...args], { timeoutMs });
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const rootResult = await git(['rev-parse', '--show-toplevel'], cwd).catch(() => null);
  if (!rootResult || rootResult.code !== 0) return { isGit: false, root: null, branch: null, head: null, upstream: null, files: [], dirty: false };
  const root = rootResult.stdout.trim();
  const [status, branch, head, upstream] = await Promise.all([
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
    git(['branch', '--show-current'], root),
    git(['rev-parse', 'HEAD'], root).catch(() => ({ code: 1, stdout: '', stderr: '' })),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root).catch(() => ({ code: 1, stdout: '', stderr: '' })),
  ]);
  const entries = status.stdout.split('\0').filter(Boolean);
  const files: GitStatus['files'] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const indexState = entry[0] || ' ';
    const worktreeState = entry[1] || ' ';
    let path = entry.slice(3);
    if ((indexState === 'R' || indexState === 'C') && entries[index + 1]) path = `${path} -> ${entries[++index]}`;
    files.push({ path, index: indexState, worktree: worktreeState });
  }
  return {
    isGit: true,
    root,
    branch: branch.stdout.trim() || null,
    head: head.code === 0 ? head.stdout.trim() : null,
    upstream: upstream.code === 0 ? upstream.stdout.trim() : null,
    files,
    dirty: files.length > 0,
  };
}

export async function getDiff(cwd: string, maxChars = 80_000): Promise<string> {
  const [unstaged, staged, untracked] = await Promise.all([
    git(['diff', '--no-ext-diff', '--'], cwd),
    git(['diff', '--cached', '--no-ext-diff', '--'], cwd),
    getGitStatus(cwd),
  ]);
  const extra = untracked.files.filter((file) => file.index === '?' && file.worktree === '?').map((file) => `UNTRACKED: ${file.path}`).join('\n');
  return `${staged.stdout}\n${unstaged.stdout}\n${extra}`.slice(0, maxChars);
}

export async function getRecentCommits(cwd: string, count = 10): Promise<string> {
  const result = await git(['log', `-${count}`, '--oneline', '--no-merges'], cwd).catch(() => null);
  return result?.code === 0 ? result.stdout.trim() : '';
}

export async function commitPaths(cwd: string, paths: string[], title: string, body: string) {
  if (!paths.length) throw new Error('No paths were provided for commit');
  const normalized = [...new Set(paths.map((value) => value.includes(' -> ') ? value.split(' -> ').at(-1)! : value))];
  const add = await git(['add', '--', ...normalized], cwd);
  if (add.code !== 0) throw new Error(add.stderr || 'git add failed');
  const commit = await git(['commit', '-m', title.slice(0, 72), '-m', body.slice(0, 4000)], cwd, 60_000);
  if (commit.code !== 0) throw new Error(commit.stderr || commit.stdout || 'git commit failed');
  const head = await git(['rev-parse', 'HEAD'], cwd);
  return head.stdout.trim();
}

export async function pushCurrent(cwd: string) {
  const status = await getGitStatus(cwd);
  if (!status.upstream) return { pushed: false, error: 'No upstream is configured for the current branch.' };
  const result = await git(['push'], cwd, 120_000);
  return result.code === 0 ? { pushed: true, error: null } : { pushed: false, error: (result.stderr || result.stdout).trim() };
}

export function extractGitHubRemoteUrl(text: string): string | null {
  const candidates = text.match(/https:\/\/github\.com\/[^\s<>()\]"']+/gi) || [];
  for (const candidate of candidates) {
    try { return validateGitHubRemoteUrl(candidate.replace(/[.,;:!?]+$/, '')); }
    catch { /* Try the next URL in the bounded conversation context. */ }
  }
  return null;
}

export function validateGitHubRemoteUrl(value: string) {
  let remote;
  try { remote = parseGitHubRepositoryRemote(value); }
  catch { throw new Error('The local remote connector accepts only a plain HTTPS GitHub repository URL such as https://github.com/owner/repository.'); }
  if (!value.trim().startsWith('https://')) {
    throw new Error('The local remote connector accepts only a plain HTTPS GitHub repository URL such as https://github.com/owner/repository.');
  }
  return remote.canonicalUrl;
}

export async function connectGitHubRemote(cwd: string, requestedUrl: string) {
  const remoteUrl = validateGitHubRemoteUrl(requestedUrl);
  const status = await getGitStatus(cwd);
  if (!status.isGit || !status.root) throw new Error('The selected project is not a Git repository. Initialize it before connecting a remote.');
  if (!status.head || !status.branch) throw new Error('The selected project needs a committed branch before it can be pushed to a remote.');

  const existing = await git(['remote', 'get-url', 'origin'], status.root).catch(() => null);
  const existingUrl = existing?.code === 0 ? existing.stdout.trim() : null;
  if (existingUrl && comparableRemote(existingUrl) !== comparableRemote(remoteUrl)) {
    throw new Error(`This project already has a different origin (${existingUrl}). Orchestra will not overwrite it automatically.`);
  }
  if (!existingUrl) {
    const advertised = await git(['ls-remote', '--heads', '--tags', remoteUrl], status.root, 30_000);
    if (advertised.code !== 0) throw new Error(advertised.stderr.trim() || 'GitHub rejected the remote lookup. Verify the URL and authentication.');
    if (advertised.stdout.trim()) throw new Error('The requested GitHub repository already contains branches or tags. Clone or import it instead of attaching an unrelated local history.');
    const added = await git(['remote', 'add', 'origin', remoteUrl], status.root);
    if (added.code !== 0) throw new Error(added.stderr.trim() || 'Git could not add the origin remote.');
  }
  const pushed = await git(['push', '--set-upstream', 'origin', status.branch], status.root, 120_000);
  if (pushed.code !== 0) throw new Error(`Origin is configured, but the initial push failed: ${(pushed.stderr || pushed.stdout).trim()}`);
  return { remote: remoteUrl, branch: status.branch, head: status.head, alreadyConfigured: Boolean(existingUrl), pushed: true };
}

export function safeCommitTitle(value: string, fallback = 'Update project') {
  const first = value.split(/\r?\n/).find((line) => line.trim())?.replace(/^[-*#\s]+/, '').trim() || fallback;
  return first.replace(/[\r\n]+/g, ' ').slice(0, 72);
}

export function projectName(root: string) { return basename(root); }

function comparableRemote(value: string) { return value.trim().replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase(); }

export interface CheckpointFile {
  path: string;
  added: number;
  deleted: number;
}

export interface CheckpointRecord {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  isHead: boolean;
  files: CheckpointFile[];
  task?: {
    id: string;
    title: string;
    state?: string | null;
    models: string | null;
    classification: string | null;
    result: string | null;
    error: string | null;
    pushStatus: string | null;
  } | null;
}

export async function getProjectCheckpoints(cwd: string, tasks: Array<Record<string, any>> = [], limit = 40): Promise<{ checkpoints: CheckpointRecord[]; currentHead: string | null; currentBranch: string | null; isDirty: boolean }> {
  const status = await getGitStatus(cwd);
  if (!status.isGit || !status.root) return { checkpoints: [], currentHead: null, currentBranch: null, isDirty: false };

  const logResult = await git(['log', `-n${limit}`, '--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s'], status.root);
  if (logResult.code !== 0 || !logResult.stdout.trim()) {
    return { checkpoints: [], currentHead: status.head, currentBranch: status.branch, isDirty: status.dirty };
  }

  const lines = logResult.stdout.trim().split(/\r?\n/);
  const headFull = (await git(['rev-parse', 'HEAD'], status.root).catch(() => ({ stdout: '' }))).stdout.trim();

  const taskMap = new Map<string, Record<string, any>>();
  for (const t of tasks) {
    if (t && typeof t.commitSha === 'string' && t.commitSha) {
      taskMap.set(t.commitSha.toLowerCase(), t);
      if (t.commitSha.length >= 7) taskMap.set(t.commitSha.slice(0, 7).toLowerCase(), t);
    }
  }

  const checkpoints: CheckpointRecord[] = [];

  for (const line of lines) {
    const [sha, shortSha, author, date, ...rest] = line.split('\t');
    if (!sha) continue;
    const message = rest.join('\t');

    const statResult = await git(['show', '--numstat', '--pretty=', sha], status.root, 10_000).catch(() => null);
    const files: CheckpointFile[] = [];
    if (statResult?.code === 0 && statResult.stdout.trim()) {
      for (const statLine of statResult.stdout.trim().split(/\r?\n/)) {
        const [addStr, delStr, filePath] = statLine.split('\t');
        if (filePath) {
          files.push({
            path: filePath,
            added: parseInt(addStr, 10) || 0,
            deleted: parseInt(delStr, 10) || 0,
          });
        }
      }
    }

    const matchedTask = taskMap.get(sha.toLowerCase()) || taskMap.get(shortSha.toLowerCase()) || null;

    checkpoints.push({
      sha,
      shortSha,
      message: message || 'Checkpoint commit',
      author: author || 'Developer',
      date: date || new Date().toISOString(),
      isHead: sha.toLowerCase() === headFull.toLowerCase(),
      files,
      task: matchedTask ? {
        id: matchedTask.id,
        title: matchedTask.title,
        state: matchedTask.state || null,
        models: matchedTask.models || null,
        classification: matchedTask.classification || null,
        result: matchedTask.result || null,
        error: matchedTask.error || null,
        pushStatus: matchedTask.pushStatus || null,
      } : null,
    });
  }

  return {
    checkpoints,
    currentHead: headFull || status.head,
    currentBranch: status.branch,
    isDirty: status.dirty,
  };
}

export async function getCommitDiffDetails(cwd: string, sha: string, maxDiffChars = 60_000) {
  const status = await getGitStatus(cwd);
  if (!status.isGit || !status.root) throw new Error('Not a git repository.');

  const [statResult, patchResult] = await Promise.all([
    git(['show', '--stat', sha], status.root),
    git(['show', '--patch', '--no-color', sha], status.root),
  ]);

  return {
    sha,
    stat: statResult.stdout.slice(0, 5000),
    patch: patchResult.stdout.slice(0, maxDiffChars),
  };
}

export async function revertToCheckpoint(cwd: string, sha: string, options?: { mode?: 'rollback' | 'branch'; branchName?: string }) {
  const status = await getGitStatus(cwd);
  if (!status.isGit || !status.root) throw new Error('Not a git repository.');

  let backupStash: string | null = null;
  if (status.dirty) {
    const stashMsg = `orchestra-safety-backup-${Date.now()}`;
    const stashRes = await git(['stash', 'push', '-u', '-m', stashMsg], status.root);
    if (stashRes.code === 0) backupStash = stashMsg;
  }

  if (options?.mode === 'branch' && options.branchName) {
    const safeBranch = options.branchName.trim().replace(/[^a-zA-Z0-9_\-/]/g, '-');
    const branchRes = await git(['checkout', '-b', safeBranch, sha], status.root);
    if (branchRes.code !== 0) throw new Error(branchRes.stderr || branchRes.stdout || `Failed to create branch ${safeBranch}`);
    return { ok: true, mode: 'branch', branch: safeBranch, sha, backupStash };
  }

  const checkoutRes = await git(['checkout', sha], status.root);
  if (checkoutRes.code !== 0) throw new Error(checkoutRes.stderr || checkoutRes.stdout || `Failed to checkout ${sha}`);

  return { ok: true, mode: 'rollback', sha, backupStash };
}

export async function createManualCheckpoint(cwd: string, message: string) {
  const status = await getGitStatus(cwd);
  if (!status.isGit || !status.root) throw new Error('Not a git repository.');

  const title = `checkpoint: ${message.trim().slice(0, 60) || 'manual snapshot'}`;
  await git(['add', '-A'], status.root);
  const commitRes = await git(['commit', '-m', title, '--allow-empty'], status.root);
  if (commitRes.code !== 0) throw new Error(commitRes.stderr || commitRes.stdout || 'Failed to create checkpoint commit');

  const head = (await git(['rev-parse', 'HEAD'], status.root)).stdout.trim();
  return { ok: true, sha: head, title };
}
