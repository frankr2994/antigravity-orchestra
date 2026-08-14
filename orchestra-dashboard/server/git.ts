import { basename } from 'node:path';
import { runProcess } from './process.js';

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
    git(['rev-parse', '--short', 'HEAD'], root).catch(() => ({ code: 1, stdout: '', stderr: '' })),
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

export function safeCommitTitle(value: string, fallback = 'Update project') {
  const first = value.split(/\r?\n/).find((line) => line.trim())?.replace(/^[-*#\s]+/, '').trim() || fallback;
  return first.replace(/[\r\n]+/g, ' ').slice(0, 72);
}

export function projectName(root: string) { return basename(root); }
