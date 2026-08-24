import type { Store } from '../../db.js';
import type { AgentName, Project, TaskEventType } from '../../domain/index.js';
import { sliceSemanticCommits, summarizeChanges } from '../../agents.js';
import { commitPaths, getDiff, getGitStatus, pushCurrent, safeCommitTitle } from '../../git.js';
import { isOrchestraInternalPath } from '../../projects.js';
import { appendHandoff } from './handoff.js';

type Emit = (agent: AgentName, type: TaskEventType, payload: unknown) => void;

export type GitFinalizationResult =
  | { status: 'skipped'; reason: 'not_git' | 'no_changes'; head: string | null; branch: string | null }
  | { status: 'committed'; commitSha: string; pushStatus: 'pushed' | 'unpushed'; branch: string | null };

type GitFinalizationDependencies = {
  summarize: typeof summarizeChanges;
  slice: typeof sliceSemanticCommits;
  status: typeof getGitStatus;
  diff: typeof getDiff;
  commit: typeof commitPaths;
  push: typeof pushCurrent;
  handoff: typeof appendHandoff;
};

const defaultDependencies: GitFinalizationDependencies = {
  summarize: summarizeChanges,
  slice: sliceSemanticCommits,
  status: getGitStatus,
  diff: getDiff,
  commit: commitPaths,
  push: pushCurrent,
  handoff: appendHandoff,
};

export function deterministicChangeSummary(paths: string[]) {
  const shown = paths.slice(0, 8);
  const remaining = paths.length - shown.length;
  return {
    title: 'chore: finalize reviewed changes',
    summary: [
      `- Finalized user-approved changes across ${paths.length} project file${paths.length === 1 ? '' : 's'}.`,
      shown.length ? `- Updated: ${shown.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}.` : '',
    ].filter(Boolean).join('\n'),
  };
}

export class GitFinalizationService {
  private readonly dependencies: GitFinalizationDependencies;

  constructor(private readonly store: Store, dependencies: Partial<GitFinalizationDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async finalize(taskId: string, project: Project, request: string, transition: (state: 'summarizing' | 'committing' | 'pushing') => void, emit: Emit): Promise<GitFinalizationResult> {
    const current = await this.dependencies.status(project.root);
    const projectFiles = current.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (!current.isGit) return { status: 'skipped', reason: 'not_git', head: current.head, branch: current.branch };
    if (!projectFiles.length) return { status: 'skipped', reason: 'no_changes', head: current.head, branch: current.branch };
    transition('summarizing');
    const diff = await this.dependencies.diff(project.root);
    let summary: { title: string; summary: string };
    try {
      summary = await this.dependencies.summarize(diff, request);
    } catch (error) {
      summary = deterministicChangeSummary(projectFiles.map((file) => file.path));
      emit('gemma', 'warning', {
        message: `The local model could not produce commit notes, so Orchestra used a deterministic summary and continued. ${error instanceof Error ? error.message : String(error)}`,
        nextAction: 'No action is required; the approved files are still being finalized.',
      });
    }
    this.dependencies.handoff(project.root, summary.summary, safeCommitTitle(summary.title));
    emit('gemma', 'agent.completed', { phase: 'handoff', ...summary });
    transition('committing');
    const updated = await this.dependencies.status(project.root);
    const paths = updated.files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path));
    if (!paths.length) return { status: 'skipped', reason: 'no_changes', head: updated.head, branch: updated.branch };

    emit('gemma', 'agent.started', { phase: 'semantic-commit-slicing', changedFiles: paths.length });
    let slices = [{ title: summary.title, body: summary.summary, files: paths }];
    try {
      slices = await this.dependencies.slice(diff, paths, request);
      emit('gemma', 'agent.completed', { phase: 'semantic-commit-slicing', sliceCount: slices.length });
    } catch (error) {
      emit('gemma', 'warning', { message: `Semantic commit slicing was unavailable; creating single commit. ${error instanceof Error ? error.message : String(error)}` });
    }
    let latestSha = '';
    for (const slice of slices) {
      latestSha = await this.dependencies.commit(project.root, slice.files, safeCommitTitle(slice.title), slice.body);
      emit('git', 'git.commit', { kind: 'task', sha: latestSha, title: slice.title, files: slice.files });
    }
    this.store.updateTask(taskId, { commitSha: latestSha });
    transition('pushing');
    const pushed = await this.dependencies.push(project.root);
    const pushStatus = pushed.pushed ? 'pushed' : 'unpushed';
    this.store.updateTask(taskId, { pushStatus });
    this.store.createGitOperation(project.id, taskId, 'task', latestSha, updated.branch, pushStatus, pushed.error);
    emit('git', 'git.push', pushed);
    return { status: 'committed', commitSha: latestSha, pushStatus, branch: updated.branch };
  }
}
