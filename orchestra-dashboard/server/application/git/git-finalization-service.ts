import type { Store } from '../../db.js';
import type { AgentName, Project, TaskEventType } from '../../domain/index.js';
import { sliceSemanticCommits, summarizeChanges } from '../../agents.js';
import { commitPaths, getDiff, getGitStatus, pushCurrent, safeCommitTitle } from '../../git.js';
import { isOrchestraInternalPath } from '../../projects.js';
import { appendHandoff } from './handoff.js';

type Emit = (agent: AgentName, type: TaskEventType, payload: unknown) => void;

export class GitFinalizationService {
  constructor(private readonly store: Store) {}
  async finalize(taskId: string, project: Project, request: string, transition: (state: 'summarizing' | 'committing' | 'pushing') => void, emit: Emit) {
    const current = await getGitStatus(project.root);
    const projectFiles = current.files.filter((file) => !isOrchestraInternalPath(file.path));
    if (!current.isGit || !projectFiles.length) return;
    transition('summarizing');
    const diff = await getDiff(project.root);
    const summary = await summarizeChanges(diff, request);
    appendHandoff(project.root, summary.summary, safeCommitTitle(summary.title));
    emit('gemma', 'agent.completed', { phase: 'handoff', ...summary });
    transition('committing');
    const updated = await getGitStatus(project.root);
    const paths = updated.files.map((file) => file.path).filter((path) => !isOrchestraInternalPath(path));
    if (!paths.length) return;

    emit('gemma', 'agent.started', { phase: 'semantic-commit-slicing', changedFiles: paths.length });
    let slices = [{ title: summary.title, body: summary.summary, files: paths }];
    try {
      slices = await sliceSemanticCommits(diff, paths, request);
      emit('gemma', 'agent.completed', { phase: 'semantic-commit-slicing', sliceCount: slices.length });
    } catch (error) {
      emit('gemma', 'warning', { message: `Semantic commit slicing was unavailable; creating single commit. ${error instanceof Error ? error.message : String(error)}` });
    }
    let latestSha = '';
    for (const slice of slices) {
      latestSha = await commitPaths(project.root, slice.files, safeCommitTitle(slice.title), slice.body);
      emit('git', 'git.commit', { kind: 'task', sha: latestSha, title: slice.title, files: slice.files });
    }
    this.store.updateTask(taskId, { commitSha: latestSha });
    transition('pushing');
    const pushed = await pushCurrent(project.root);
    this.store.updateTask(taskId, { pushStatus: pushed.pushed ? 'pushed' : 'unpushed' });
    this.store.createGitOperation(project.id, taskId, 'task', latestSha, updated.branch, pushed.pushed ? 'pushed' : 'unpushed', pushed.error);
    emit('git', 'git.push', pushed);
  }
}
