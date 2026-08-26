import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { git } from '../../git.js';

const ROOT_NAME = 'review-worktrees';

export function getManagedWorktreePath(projectRoot: string, taskId: string): string {
  const cleanTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!cleanTaskId) throw new TypeError('A stable task identity is required for a managed worktree.');
  const repository = createHash('sha256').update(resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 16);
  return join(config.dataDir, ROOT_NAME, repository, cleanTaskId);
}

function assertManagedWorktreePath(path: string): void {
  const base = resolve(config.dataDir, ROOT_NAME);
  const target = resolve(path);
  const child = relative(base, target);
  if (!child || child.startsWith('..') || resolve(base, child) !== target) {
    throw new Error('Refusing to modify an unmanaged worktree path.');
  }
}

export async function createManagedWorktree(projectRoot: string, taskId: string, commitShaOrRef: string): Promise<string> {
  const worktreePath = getManagedWorktreePath(projectRoot, taskId);
  assertManagedWorktreePath(worktreePath);
  mkdirSync(dirname(worktreePath), { recursive: true });
  if (existsSync(worktreePath)) {
    await git(['worktree', 'remove', '--force', worktreePath], projectRoot).catch(() => null);
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* Windows locks are retried below. */ }
  }
  const result = await git(['worktree', 'add', '--detach', worktreePath, commitShaOrRef], projectRoot);
  if (result.code !== 0) throw new Error(`Failed to create isolated Git worktree: ${(result.stderr || result.stdout).trim()}`);
  return worktreePath;
}

export async function cleanupManagedWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  assertManagedWorktreePath(worktreePath);
  await git(['worktree', 'remove', '--force', worktreePath], projectRoot).catch(() => null);
  await git(['worktree', 'prune'], projectRoot).catch(() => null);
  for (let attempt = 0; existsSync(worktreePath) && attempt < 3; attempt += 1) {
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* retry expected Windows locks */ }
    if (existsSync(worktreePath)) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50 * (attempt + 1)));
  }
  if (existsSync(worktreePath)) throw new Error('Managed worktree cleanup remains pending because files are locked.');
}
