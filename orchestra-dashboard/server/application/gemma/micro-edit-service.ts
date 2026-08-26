import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from '../../config.js';
import { executeGemmaMicroTask } from '../../agents.js';
import { git, getGitStatus } from '../../git.js';
import { createManagedWorktree, cleanupManagedWorktree } from '../../infrastructure/git/managed-worktree.js';
import { verifyProject, verificationFailure } from '../../verification.js';
import type { VerificationResult } from '../../verification.js';

const DISALLOWED_PATH = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.github|migrations?|auth|security|credentials?)(?:\/|$)/i;

export interface GemmaMicroEditResult {
  applied: boolean;
  reason: string;
  changedFiles: string[];
  changedLines: number;
  summary: string;
}

export interface GemmaMicroEditDependencies {
  generate: typeof executeGemmaMicroTask;
  verify: (root: string, signal: AbortSignal) => Promise<VerificationResult[]>;
  createWorktree: typeof createManagedWorktree;
  cleanupWorktree: typeof cleanupManagedWorktree;
}

const DEFAULT_DEPENDENCIES: GemmaMicroEditDependencies = {
  generate: executeGemmaMicroTask,
  verify: verifyProject,
  createWorktree: createManagedWorktree,
  cleanupWorktree: cleanupManagedWorktree,
};

export class GemmaMicroEditService {
  constructor(private readonly dependencies: GemmaMicroEditDependencies = DEFAULT_DEPENDENCIES) {}

  async attempt(input: { taskId: string; projectRoot: string; baseSha: string; prompt: string; signal: AbortSignal; onOutput?: (chunk: string) => void; onUsage?: (usage: Record<string, number>) => void }): Promise<GemmaMicroEditResult> {
    if (!/^[0-9a-f]{40}$/i.test(input.baseSha)) return this.rejected('A full Git base identity is required.');
    const status = await getGitStatus(input.projectRoot);
    if (!status.isGit || status.dirty || status.head !== input.baseSha) return this.rejected('The bounded local-model workflow requires a clean repository at the classified base commit.');
    let worktree: string | null = null;
    const patchDir = resolve(config.dataDir, 'micro-edit-patches');
    const patchPath = join(patchDir, `${input.taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}.patch`);
    try {
      worktree = await this.dependencies.createWorktree(input.projectRoot, `gemma-${input.taskId}`, input.baseSha);
      const generated = await this.dependencies.generate({ root: worktree, prompt: input.prompt, signal: input.signal, onOutput: input.onOutput, onUsage: input.onUsage });
      await git(['add', '-N', '--', '.'], worktree);
      const [nameStatus, numstat, patch] = await Promise.all([
        git(['diff', '--name-status', '--', '.'], worktree),
        git(['diff', '--numstat', '--', '.'], worktree),
        git(['diff', '--binary', '--', '.'], worktree),
      ]);
      if (nameStatus.code !== 0 || numstat.code !== 0 || patch.code !== 0) return this.rejected('Git could not validate the isolated Gemma candidate.');
      const entries = nameStatus.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split(/\t+/));
      const changedFiles = entries.map((entry) => entry.at(-1) || '').filter(Boolean);
      const changedLines = numstat.stdout.split(/\r?\n/).filter(Boolean).reduce((total, line) => {
        const [added, deleted] = line.split(/\t/);
        if (added === '-' || deleted === '-') return Number.POSITIVE_INFINITY;
        return total + Number(added || 0) + Number(deleted || 0);
      }, 0);
      if (!changedFiles.length) return this.rejected('Gemma produced no project diff.');
      if (changedFiles.length > 3 || changedLines > 200) return this.rejected(`The candidate exceeded the micro-edit gate (${changedFiles.length} files, ${changedLines} changed lines).`);
      if (entries.some(([kind]) => /^(?:D|R|C)/.test(kind || '')) || changedFiles.some((path) => DISALLOWED_PATH.test(path.replaceAll('\\', '/')))) {
        return this.rejected('The candidate touched a path or change type reserved for a stronger workflow.');
      }
      const verification = await this.dependencies.verify(worktree, input.signal);
      const failure = verificationFailure(verification);
      if (failure) return this.rejected(`The isolated candidate failed verification: ${failure.slice(0, 500)}`);
      if (!patch.stdout.trim()) return this.rejected('The isolated candidate did not produce an applicable patch.');
      mkdirSync(dirname(patchPath), { recursive: true });
      writeFileSync(patchPath, patch.stdout, 'utf8');
      const check = await git(['apply', '--check', '--', patchPath], input.projectRoot);
      if (check.code !== 0) return this.rejected(`The verified candidate no longer applies cleanly: ${(check.stderr || check.stdout).trim().slice(0, 500)}`);
      const applied = await git(['apply', '--', patchPath], input.projectRoot);
      if (applied.code !== 0) throw new Error(`Git could not apply the verified Gemma candidate: ${(applied.stderr || applied.stdout).trim()}`);
      return { applied: true, reason: 'The isolated candidate passed the bounded diff and deterministic verification gates.', changedFiles, changedLines, summary: generated.result };
    } catch (error) {
      if (input.signal.aborted) throw error;
      return this.rejected(error instanceof Error ? error.message : String(error));
    } finally {
      if (worktree) await this.dependencies.cleanupWorktree(input.projectRoot, worktree);
      if (existsSync(patchPath)) try { unlinkSync(patchPath); } catch { /* A later cleanup pass can remove an inert patch file. */ }
    }
  }

  private rejected(reason: string): GemmaMicroEditResult { return { applied: false, reason, changedFiles: [], changedLines: 0, summary: '' }; }
}
