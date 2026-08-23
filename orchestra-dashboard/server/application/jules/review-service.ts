import { randomUUID } from 'node:crypto';
import type { Store } from '../../db.js';
import { git, getGitStatus } from '../../git.js';
import { getWorktreePath, runWorktreeReview } from '../../providers/jules/worktree-review.js';
import { runCodexReviewForJules, type JulesCodexReviewResult } from '../../providers/jules/codex-review.js';
import { ApplicationError } from '../errors.js';
import { executeDualEngineRepair, type DualEngineRepairResult } from '../../providers/jules/repair-coordinator.js';
import { redactSecrets } from '../../infrastructure/security/redaction.js';

const FULL_SHA = /^[0-9a-f]{40}$/i;

export interface JulesReviewServiceOptions {
  codexRunner?: (prompt: string, options: { model: string; effort: 'low' | 'medium' | 'high' }) => Promise<string>;
  repairHandler?: (input: Parameters<typeof executeDualEngineRepair>[0]) => Promise<DualEngineRepairResult>;
}

function parsePullRequestUrl(value: string): { owner: string; repo: string; number: number } {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApplicationError('INVALID_PR_IDENTITY', 'The Jules output did not contain a valid GitHub pull request URL.', 409); }
  const parts = url.pathname.split('/').filter(Boolean);
  const number = Number(parts[3]);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash ||
      parts.length !== 4 || parts[2] !== 'pull' || !Number.isSafeInteger(number) || number < 1) {
    throw new ApplicationError('INVALID_PR_IDENTITY', 'The Jules output did not identify one exact GitHub pull request.', 409);
  }
  return { owner: parts[0], repo: parts[1], number };
}

export class JulesReviewService {
  constructor(private readonly store: Store, private readonly options: JulesReviewServiceOptions = {}) {}

  async reviewAndIntegrate(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!task) throw new ApplicationError('TASK_NOT_FOUND', 'Task not found.', 404);
    const project = this.store.getProject(task.projectId);
    const cloud = this.store.manager.cloudSessions.getByTaskId(taskId);
    const mapping = this.store.manager.julesSourceMappings.get(task.projectId);
    if (!project || !cloud || !mapping || !cloud.prUrl) {
      throw new ApplicationError('PR_NOT_READY', 'The task does not yet have a verified Jules pull request identity.', 409);
    }
    if (!FULL_SHA.test(cloud.baseSha)) throw new ApplicationError('INVALID_BASE_SHA', 'The dispatch base identity is invalid.', 409);
    const pullRequest = parsePullRequestUrl(cloud.prUrl);
    if (pullRequest.owner.toLowerCase() !== mapping.githubOwner.toLowerCase() || pullRequest.repo.toLowerCase() !== mapping.githubRepo.toLowerCase()) {
      throw new ApplicationError('PR_REPOSITORY_MISMATCH', 'The Jules pull request belongs to a different repository.', 409);
    }
    const status = await getGitStatus(project.root);
    if (!status.isGit || !status.root) throw new ApplicationError('GIT_REPOSITORY_UNAVAILABLE', 'The project Git repository is unavailable.', 409);
    const ownerId = `jules-review-${randomUUID()}`;
    const lease = this.store.manager.leases.acquire('git_repository', status.root, ownerId, 30 * 60_000);
    if (!lease) throw new ApplicationError('REPOSITORY_BUSY', 'Another workflow currently owns this repository.', 409);

    try {
      const prRef = `refs/pull/${pullRequest.number}/head`;
      const advertised = await git(['ls-remote', 'origin', prRef], status.root, 60_000);
      const rows = advertised.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[1] === prRef);
      if (advertised.code !== 0 || rows.length !== 1 || !FULL_SHA.test(rows[0][0])) {
        throw new ApplicationError('PR_HEAD_UNAVAILABLE', 'The exact pull request head could not be resolved from origin.', 409);
      }
      const headSha = rows[0][0].toLowerCase();
      if (this.store.manager.evidence.list(taskId, 'review').some((item) => item.subjectSha?.toLowerCase() === headSha)) {
        this.store.updateTask(taskId, { state: 'review_disputed', error: 'Jules completed without changing the previously reviewed pull request head.' });
        this.store.manager.julesCapacity.release(taskId);
        throw new ApplicationError('PR_HEAD_UNCHANGED', 'The pull request head has not changed since the previous review.', 409);
      }
      const fetch = await git(['fetch', '--no-tags', 'origin', headSha], status.root, 120_000);
      if (fetch.code !== 0) throw new ApplicationError('PR_FETCH_FAILED', 'The exact pull request head could not be fetched.', 409);
      const object = await git(['rev-parse', '--verify', `${headSha}^{commit}`], status.root);
      if (object.code !== 0 || object.stdout.trim().toLowerCase() !== headSha) throw new ApplicationError('PR_HEAD_MISMATCH', 'The fetched pull request head did not match its advertised identity.', 409);
      const ancestry = await git(['merge-base', '--is-ancestor', cloud.baseSha, headSha], status.root);
      if (ancestry.code !== 0) throw new ApplicationError('PR_BASE_MISMATCH', 'The pull request is not descended from the immutable dispatch base.', 409);
      this.store.manager.leases.assertFence('git_repository', status.root, ownerId, lease.fencingToken);

      const worktreeResource = this.store.manager.managedGitResources.register({ taskId, attemptId: cloud.attemptId,
        repositoryRoot: status.root, kind: 'worktree', resourceValue: getWorktreePath(status.root, taskId) });
      const review = await runWorktreeReview({ taskId, projectRoot: status.root, baseSha: cloud.baseSha, headSha, skipFetch: true });
      this.store.manager.managedGitResources.completeCleanup(worktreeResource.id, true);
      if (!review.ok || !review.verified) {
        this.store.manager.evidence.record({ taskId, attemptId: cloud.attemptId, kind: 'verification', subjectSha: headSha,
          outcome: 'failed', payload: { changedFiles: review.changedFiles, errorCode: 'LOCAL_VERIFICATION_FAILED',
            results: review.verificationResults.map((result) => ({ command: result.command, code: result.code, output: redactSecrets(result.output).slice(-12_000) })) } });
        this.store.updateTask(taskId, { state: 'reviewing', error: 'Local verification of the Jules pull request failed.' });
        const findings = [{ severity: 'blocking' as const,
          explanation: review.error ?? 'Deterministic verification failed; inspect the attached command results and correct the pull request.' }];
        const repair = await (this.options.repairHandler ?? executeDualEngineRepair)({
          taskId, projectRoot: status.root, remoteSessionId: cloud.remoteSessionId, baseSha: cloud.baseSha,
          headSha, findings, verificationResults: review.verificationResults, store: this.store,
        });
        return { ok: false, stage: 'repair', headSha, review, repair };
      }
      const codex: JulesCodexReviewResult = await runCodexReviewForJules({
        taskId, projectRoot: status.root, request: task.prompt, baseSha: cloud.baseSha, headSha,
        diff: review.diff, changedFiles: review.changedFiles, verificationResults: review.verificationResults,
        store: this.store, codexRunner: this.options.codexRunner,
      });
      this.store.manager.evidence.record({ taskId, attemptId: cloud.attemptId, kind: 'review', subjectSha: headSha,
        outcome: codex.verdict.toLowerCase(), payload: { summary: codex.summary.slice(0, 2_000), findings: codex.findings,
          rawReviewText: redactSecrets(codex.rawReviewText).slice(0, 100_000),
          verification: review.verificationResults.map((result) => ({ command: result.command, code: result.code })) } });
      if (codex.blocked) {
        this.store.updateTask(taskId, { state: 'reviewing', error: 'Independent review blocked integration.' });
        const repair = await (this.options.repairHandler ?? executeDualEngineRepair)({
          taskId, projectRoot: status.root, remoteSessionId: cloud.remoteSessionId, baseSha: cloud.baseSha,
          headSha, findings: codex.findings, verificationResults: review.verificationResults, store: this.store,
        });
        return { ok: false, stage: 'repair', headSha, review, codex, repair };
      }

      this.store.manager.leases.assertFence('git_repository', status.root, ownerId, lease.fencingToken);
      const refreshedPr = await git(['ls-remote', 'origin', prRef], status.root, 60_000);
      if (refreshedPr.code !== 0 || refreshedPr.stdout.trim().split(/\s+/)[0]?.toLowerCase() !== headSha) {
        throw new ApplicationError('PR_HEAD_CHANGED', 'The pull request changed after verification; review must restart on the new head.', 409);
      }
      const pushUrl = await git(['remote', 'get-url', '--push', 'origin'], status.root);
      const targetRef = `refs/heads/${cloud.targetBranch}`;
      const target = await git(['ls-remote', '--heads', pushUrl.stdout.trim(), targetRef], status.root, 60_000);
      const targetSha = target.stdout.trim().split(/\s+/)[0]?.toLowerCase();
      if (target.code !== 0 || targetSha !== cloud.baseSha.toLowerCase()) {
        throw new ApplicationError('TARGET_BRANCH_MOVED', 'The target branch changed after dispatch; automatic integration stopped.', 409);
      }
      const pushed = await git(['push', 'origin', `${headSha}:${targetRef}`], status.root, 120_000);
      if (pushed.code !== 0) throw new ApplicationError('INTEGRATION_PUSH_FAILED', 'Git rejected the safe fast-forward integration.', 409);
      const readBack = await git(['ls-remote', '--heads', pushUrl.stdout.trim(), targetRef], status.root, 60_000);
      if (readBack.stdout.trim().split(/\s+/)[0]?.toLowerCase() !== headSha) {
        throw new ApplicationError('INTEGRATION_READBACK_FAILED', 'The integrated target did not resolve to the reviewed commit.', 409);
      }
      this.store.manager.transaction(() => {
        this.store.manager.leases.assertFence('git_repository', status.root!, ownerId, lease.fencingToken);
        this.store.manager.cloudSessions.update(cloud.id, { prHeadSha: headSha });
        if (cloud.attemptId) this.store.manager.attempts.update(cloud.attemptId, { headSha, prUrl: cloud.prUrl, state: 'COMPLETED', completedAt: new Date().toISOString() });
        this.store.manager.evidence.record({ taskId, attemptId: cloud.attemptId, kind: 'integration', subjectSha: headSha,
          outcome: 'integrated', payload: { targetBranch: cloud.targetBranch, baseSha: cloud.baseSha, prUrl: cloud.prUrl } });
        this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'integration', subjectSha: headSha,
          data: { status: 'completed', targetBranch: cloud.targetBranch } });
        this.store.updateTask(taskId, { state: 'completed', result: `Integrated reviewed Jules PR ${cloud.prUrl}`, error: null });
        this.store.manager.julesCapacity.release(taskId);
        this.store.addEvent(taskId, 'orchestra', 'cloud.integrated', { headSha, baseSha: cloud.baseSha, targetBranch: cloud.targetBranch, prUrl: cloud.prUrl });
        this.store.manager.managedGitResources.scheduleTaskCleanup(taskId);
      });
      return { ok: true, stage: 'integrated', headSha, review, codex };
    } finally {
      this.store.manager.leases.release('git_repository', status.root, ownerId, lease.fencingToken);
    }
  }
}
