import { randomUUID } from 'node:crypto';
import type { Store } from '../../db.js';
import { git, getGitStatus } from '../../git.js';
import { getWorktreePath, runWorktreeReview, type WorktreeReviewResult } from '../../providers/jules/worktree-review.js';
import { runCodexReviewForJules, type JulesCodexReviewResult } from '../../providers/jules/codex-review.js';
import { ApplicationError } from '../errors.js';
import { executeDualEngineRepair, type DualEngineRepairResult } from '../../providers/jules/repair-coordinator.js';
import { redactSecrets } from '../../infrastructure/security/redaction.js';
import type { ReviewFinding } from '../../domain/execution/review.js';
import { isOrchestraInternalPath } from '../../projects.js';

const FULL_SHA = /^[0-9a-f]{40}$/i;
const ZERO_SHA = '0000000000000000000000000000000000000000';

export interface JulesReviewServiceOptions {
  codexRunner?: (prompt: string, options: { model: string; effort: 'low' | 'medium' | 'high' }) => Promise<string>;
  repairHandler?: (input: Parameters<typeof executeDualEngineRepair>[0]) => Promise<DualEngineRepairResult>;
}

export interface LocalTargetSyncResult {
  synced: boolean;
  mode: 'already_current' | 'fast_forwarded' | 'updated_ref' | 'created_ref' | 'blocked';
  reason?: string;
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

function findingsFromEvidence(payload: Record<string, unknown>): ReviewFinding[] {
  if (!Array.isArray(payload.findings)) return [];
  return payload.findings.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const finding = value as Record<string, unknown>;
    if (typeof finding.explanation !== 'string') return [];
    const severity = ['blocking', 'warning', 'info'].includes(String(finding.severity))
      ? String(finding.severity) as ReviewFinding['severity']
      : 'blocking';
    return [{
      severity,
      explanation: finding.explanation,
      ...(typeof finding.file === 'string' ? { file: finding.file } : {}),
      ...(Number.isSafeInteger(finding.line) ? { line: Number(finding.line) } : {}),
      ...(typeof finding.evidence === 'string' ? { evidence: finding.evidence } : {}),
      ...(typeof finding.recommendation === 'string' ? { recommendation: finding.recommendation } : {}),
    }];
  });
}

function verificationFromEvidence(payload: Record<string, unknown>): WorktreeReviewResult['verificationResults'] | undefined {
  if (!Array.isArray(payload.results)) return undefined;
  const results = payload.results.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const result = value as Record<string, unknown>;
    if (typeof result.command !== 'string' || !Number.isFinite(Number(result.code))) return [];
    return [{ command: result.command, code: Number(result.code), output: typeof result.output === 'string' ? result.output : '' }];
  });
  return results.length ? results : undefined;
}

/** Safely advances the local target branch to the exact reviewed PR head. */
export async function synchronizeLocalTargetBranch(input: {
  projectRoot: string;
  targetBranch: string;
  baseSha: string;
  headSha: string;
  checkoutTarget?: boolean;
}): Promise<LocalTargetSyncResult> {
  if (!FULL_SHA.test(input.baseSha) || !FULL_SHA.test(input.headSha)) {
    return { synced: false, mode: 'blocked', reason: 'The branch synchronization identities are invalid.' };
  }
  const status = await getGitStatus(input.projectRoot);
  if (!status.isGit || !status.root) return { synced: false, mode: 'blocked', reason: 'The local Git repository is unavailable.' };
  const validBranch = await git(['check-ref-format', '--branch', input.targetBranch], status.root);
  if (validBranch.code !== 0) return { synced: false, mode: 'blocked', reason: 'The Jules target branch name is invalid.' };

  const ref = `refs/heads/${input.targetBranch}`;
  const local = await git(['rev-parse', '--verify', ref], status.root).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  const localSha = local.code === 0 ? local.stdout.trim().toLowerCase() : null;
  const headSha = input.headSha.toLowerCase();
  const baseSha = input.baseSha.toLowerCase();
  if (localSha === headSha && (!input.checkoutTarget || status.branch === input.targetBranch)) {
    return { synced: true, mode: 'already_current' };
  }
  if (localSha && localSha !== baseSha && localSha !== headSha) {
    return { synced: false, mode: 'blocked', reason: `Local branch ${input.targetBranch} moved away from the immutable dispatch base.` };
  }

  const changedFiles = status.files.filter((file) => !isOrchestraInternalPath(file.path));
  const mustTouchWorktree = status.branch === input.targetBranch || Boolean(input.checkoutTarget);
  if (mustTouchWorktree && changedFiles.length) {
    return { synced: false, mode: 'blocked', reason: `The local worktree has ${changedFiles.length} preserved change${changedFiles.length === 1 ? '' : 's'}; Orchestra will not overwrite or switch branches.` };
  }

  if (input.checkoutTarget && status.branch !== input.targetBranch) {
    const switched = localSha
      ? await git(['switch', input.targetBranch], status.root)
      : await git(['switch', '--create', input.targetBranch, headSha], status.root);
    if (switched.code !== 0) return { synced: false, mode: 'blocked', reason: (switched.stderr || switched.stdout || 'Git could not switch to the Jules target branch.').trim() };
    if (!localSha) return { synced: true, mode: 'created_ref' };
  }

  if (status.branch === input.targetBranch || input.checkoutTarget) {
    if (localSha === headSha) return { synced: true, mode: 'already_current' };
    const merged = await git(['merge', '--ff-only', headSha], status.root, 60_000);
    return merged.code === 0
      ? { synced: true, mode: 'fast_forwarded' }
      : { synced: false, mode: 'blocked', reason: (merged.stderr || merged.stdout || 'Git could not fast-forward the local target branch.').trim() };
  }

  const updated = await git(['update-ref', ref, headSha, localSha || ZERO_SHA], status.root);
  return updated.code === 0
    ? { synced: true, mode: localSha ? 'updated_ref' : 'created_ref' }
    : { synced: false, mode: 'blocked', reason: (updated.stderr || updated.stdout || 'Git could not update the local target branch reference.').trim() };
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
    // A verified PR identity means Jules has finished its implementation run.
    // Local verification, review, and integration are tracked independently.
    this.store.finishActiveProviderRun(taskId, 'jules', 'completed');
    if (!FULL_SHA.test(cloud.baseSha)) throw new ApplicationError('INVALID_BASE_SHA', 'The dispatch base identity is invalid.', 409);
    const pullRequest = parsePullRequestUrl(cloud.prUrl);
    if (pullRequest.owner.toLowerCase() !== mapping.githubOwner.toLowerCase() || pullRequest.repo.toLowerCase() !== mapping.githubRepo.toLowerCase()) {
      throw new ApplicationError('PR_REPOSITORY_MISMATCH', 'The Jules pull request belongs to a different repository.', 409);
    }
    const status = await getGitStatus(project.root);
    if (!status.isGit || !status.root) throw new ApplicationError('GIT_REPOSITORY_UNAVAILABLE', 'The project Git repository is unavailable.', 409);
    const ownerId = `jules-review-${randomUUID()}`;
    const lease = this.store.manager.leases.acquire('git_repository', status.root, ownerId, 2 * 60 * 60_000);
    if (!lease) throw new ApplicationError('REPOSITORY_BUSY', 'Another workflow currently owns this repository.', 409);

    try {
      const prRef = `refs/pull/${pullRequest.number}/head`;
      this.store.addEvent(taskId, 'orchestra', 'cloud.reviewing', { message: 'Resolving the immutable Jules pull request head from origin.', stage: 'resolve_pr' });
      const advertised = await git(['ls-remote', 'origin', prRef], status.root, 60_000);
      const rows = advertised.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[1] === prRef);
      if (advertised.code !== 0 || rows.length !== 1 || !FULL_SHA.test(rows[0][0])) {
        throw new ApplicationError('PR_HEAD_UNAVAILABLE', 'The exact pull request head could not be resolved from origin.', 409);
      }
      const headSha = rows[0][0].toLowerCase();
      const fetch = await git(['fetch', '--no-tags', 'origin', headSha], status.root, 120_000);
      if (fetch.code !== 0) throw new ApplicationError('PR_FETCH_FAILED', 'The exact pull request head could not be fetched.', 409);
      const object = await git(['rev-parse', '--verify', `${headSha}^{commit}`], status.root);
      if (object.code !== 0 || object.stdout.trim().toLowerCase() !== headSha) throw new ApplicationError('PR_HEAD_MISMATCH', 'The fetched pull request head did not match its advertised identity.', 409);
      const ancestry = await git(['merge-base', '--is-ancestor', cloud.baseSha, headSha], status.root);
      if (ancestry.code !== 0) throw new ApplicationError('PR_BASE_MISMATCH', 'The pull request is not descended from the immutable dispatch base.', 409);
      this.store.manager.leases.assertFence('git_repository', status.root, ownerId, lease.fencingToken);

      const integrated = this.store.manager.evidence.list(taskId, 'integration').find((item) => item.subjectSha?.toLowerCase() === headSha && item.outcome === 'integrated');
      if (integrated) {
        const localSync = await synchronizeLocalTargetBranch({ projectRoot: status.root, targetBranch: cloud.targetBranch, baseSha: cloud.baseSha, headSha });
        this.store.manager.julesCapacity.release(taskId);
        return { ok: true, stage: 'integrated', headSha, reusedIntegration: true, localSync };
      }

      const evidence = this.store.manager.evidence.list(taskId).filter((item) => item.subjectSha?.toLowerCase() === headSha);
      const priorReview = evidence.filter((item) => item.kind === 'review').at(-1);
      const priorVerification = evidence.filter((item) => item.kind === 'verification' && item.outcome === 'failed').at(-1);
      const priorVerificationFailure = Boolean(priorVerification);
      const reuseApprovedReview = priorReview?.outcome === 'pass';
      if ((priorReview && !reuseApprovedReview) || (priorVerificationFailure && !reuseApprovedReview)) {
        const findings = priorReview ? findingsFromEvidence(priorReview.payload) : [];
        if (!findings.length) findings.push({ severity: 'blocking',
          explanation: 'The unchanged Jules pull request still has the previously recorded review or verification failure.' });
        const verificationResults = priorVerification ? verificationFromEvidence(priorVerification.payload) : undefined;
        const message = 'Jules completed without changing the blocked pull request head. Orchestra is sending the recorded findings again and will keep repairing until review passes or you stop the task.';
        this.store.updateTask(taskId, { state: 'reviewing', error: message });
        this.store.addEvent(taskId, 'orchestra', 'cloud.reviewing', { message, stage: 'repair_retry', headSha, reusedReview: true });
        const repair = await this.requestRepair({ taskId, projectRoot: status.root, remoteSessionId: cloud.remoteSessionId,
          baseSha: cloud.baseSha, headSha, findings, verificationResults });
        if (repair.strategy === 'local_takeover') return this.prepareLocalTakeover({ taskId, projectRoot: status.root, headSha, findings, repair });
        return { ok: false, stage: 'repair', headSha, repair, reusedReview: true };
      }

      let review: WorktreeReviewResult | undefined;
      let codex: JulesCodexReviewResult | undefined;
      if (!reuseApprovedReview) {
        this.store.updateTask(taskId, { state: 'reviewing', error: null });
        this.store.addEvent(taskId, 'orchestra', 'cloud.reviewing', { message: 'Running deterministic verification in an isolated worktree.', stage: 'verification', headSha });
        const worktreeResource = this.store.manager.managedGitResources.register({ taskId, attemptId: cloud.attemptId,
          repositoryRoot: status.root, kind: 'worktree', resourceValue: getWorktreePath(status.root, taskId) });
        try {
          review = await runWorktreeReview({ taskId, projectRoot: status.root, baseSha: cloud.baseSha, headSha, skipFetch: true });
          this.store.manager.managedGitResources.completeCleanup(worktreeResource.id, true);
        } catch (error) {
          this.store.manager.managedGitResources.completeCleanup(worktreeResource.id, false, 'WORKTREE_REVIEW_FAILED');
          throw error;
        }
        if (!review.ok || !review.verified) {
          this.store.manager.evidence.record({ taskId, attemptId: cloud.attemptId, kind: 'verification', subjectSha: headSha,
            outcome: 'failed', payload: { changedFiles: review.changedFiles, errorCode: 'LOCAL_VERIFICATION_FAILED',
              results: review.verificationResults.map((result) => ({ command: result.command, code: result.code, output: redactSecrets(result.output).slice(-12_000) })) } });
          this.store.updateTask(taskId, { state: 'reviewing', error: 'Local verification of the Jules pull request failed.' });
          const findings = [{ severity: 'blocking' as const,
            explanation: review.error ?? 'Deterministic verification failed; inspect the attached command results and correct the pull request.' }];
          const repair = await this.requestRepair({ taskId, projectRoot: status.root, remoteSessionId: cloud.remoteSessionId,
            baseSha: cloud.baseSha, headSha, findings, verificationResults: review.verificationResults });
          if (repair.strategy === 'local_takeover') return this.prepareLocalTakeover({ taskId, projectRoot: status.root, headSha, findings, repair });
          return { ok: false, stage: 'repair', headSha, review, repair };
        }

        this.store.addEvent(taskId, 'orchestra', 'cloud.reviewing', { message: 'Deterministic checks passed. Starting independent Codex review.', stage: 'independent_review', headSha });
        codex = await runCodexReviewForJules({
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
          const repair = await this.requestRepair({ taskId, projectRoot: status.root, remoteSessionId: cloud.remoteSessionId,
            baseSha: cloud.baseSha, headSha, findings: codex.findings, verificationResults: review.verificationResults });
          if (repair.strategy === 'local_takeover') return this.prepareLocalTakeover({ taskId, projectRoot: status.root, headSha, findings: codex.findings, repair });
          return { ok: false, stage: 'repair', headSha, review, codex, repair };
        }
      } else {
        this.store.addEvent(taskId, 'orchestra', 'cloud.reviewing', { message: 'Reusing the passing review for this unchanged PR head; retrying integration without another model call.', stage: 'review_reused', headSha });
      }

      this.store.manager.leases.assertFence('git_repository', status.root, ownerId, lease.fencingToken);
      const refreshedPr = await git(['ls-remote', 'origin', prRef], status.root, 60_000);
      if (refreshedPr.code !== 0 || refreshedPr.stdout.trim().split(/\s+/)[0]?.toLowerCase() !== headSha) {
        throw new ApplicationError('PR_HEAD_CHANGED', 'The pull request changed after verification; review must restart on the new head.', 409);
      }
      this.store.addEvent(taskId, 'orchestra', 'cloud.reviewing', { message: 'Review passed. Safely fast-forwarding the remote target branch.', stage: 'integration', headSha });
      const pushUrl = await git(['remote', 'get-url', '--push', 'origin'], status.root);
      const targetRef = `refs/heads/${cloud.targetBranch}`;
      const target = await git(['ls-remote', '--heads', pushUrl.stdout.trim(), targetRef], status.root, 60_000);
      const targetSha = target.stdout.trim().split(/\s+/)[0]?.toLowerCase();
      if (target.code !== 0 || ![cloud.baseSha.toLowerCase(), headSha].includes(targetSha)) {
        throw new ApplicationError('TARGET_BRANCH_MOVED', 'The target branch changed after dispatch; automatic integration stopped.', 409);
      }
      if (targetSha !== headSha) {
        const pushed = await git(['push', 'origin', `${headSha}:${targetRef}`], status.root, 120_000);
        if (pushed.code !== 0) throw new ApplicationError('INTEGRATION_PUSH_FAILED', 'Git rejected the safe fast-forward integration.', 409);
      }
      const readBack = await git(['ls-remote', '--heads', pushUrl.stdout.trim(), targetRef], status.root, 60_000);
      if (readBack.stdout.trim().split(/\s+/)[0]?.toLowerCase() !== headSha) {
        throw new ApplicationError('INTEGRATION_READBACK_FAILED', 'The integrated target did not resolve to the reviewed commit.', 409);
      }
      const localSync = await synchronizeLocalTargetBranch({ projectRoot: status.root, targetBranch: cloud.targetBranch, baseSha: cloud.baseSha, headSha });
      this.store.manager.transaction(() => {
        this.store.manager.leases.assertFence('git_repository', status.root!, ownerId, lease.fencingToken);
        this.store.manager.cloudSessions.update(cloud.id, { prHeadSha: headSha });
        for (const attempt of this.store.manager.attempts.listByTaskId(taskId)) {
          if (attempt.worker === 'jules' && attempt.state === 'WORKING') {
            this.store.manager.attempts.update(attempt.id, { headSha, prUrl: cloud.prUrl, state: 'COMPLETED', completedAt: new Date().toISOString() });
          }
        }
        this.store.manager.evidence.record({ taskId, attemptId: cloud.attemptId, kind: 'integration', subjectSha: headSha,
          outcome: 'integrated', payload: { targetBranch: cloud.targetBranch, baseSha: cloud.baseSha, prUrl: cloud.prUrl,
            localSync: localSync.synced, localSyncMode: localSync.mode, localSyncReason: localSync.reason ?? null } });
        this.store.manager.checkpoints.append({ taskId, attemptId: cloud.attemptId, stage: 'integration', subjectSha: headSha,
          data: { status: 'completed', targetBranch: cloud.targetBranch, localSync: localSync.synced, localSyncMode: localSync.mode } });
        this.store.updateTask(taskId, { state: 'completed', result: `Integrated reviewed Jules PR ${cloud.prUrl}`, error: localSync.synced ? null : localSync.reason ?? 'The remote target was integrated, but the local branch could not be synchronized.', commitSha: headSha, pushStatus: 'pushed' });
        this.store.manager.julesCapacity.release(taskId);
        this.store.addEvent(taskId, 'orchestra', 'cloud.integrated', { headSha, baseSha: cloud.baseSha, targetBranch: cloud.targetBranch, prUrl: cloud.prUrl,
          localSync: localSync.synced, message: localSync.synced ? 'Reviewed Jules changes were integrated remotely and synchronized to the local target branch.' : 'Reviewed Jules changes were integrated remotely; local synchronization was safely skipped because local state needs attention.', nextAction: localSync.synced ? null : localSync.reason });
        this.store.manager.managedGitResources.scheduleTaskCleanup(taskId);
      });
      return { ok: true, stage: 'integrated', headSha, review, codex, reusedReview: reuseApprovedReview, localSync };
    } finally {
      this.store.manager.leases.release('git_repository', status.root, ownerId, lease.fencingToken);
    }
  }

  private requestRepair(input: {
    taskId: string; projectRoot: string; remoteSessionId: string; baseSha: string; headSha: string;
    findings: ReviewFinding[]; verificationResults?: WorktreeReviewResult['verificationResults'];
  }) {
    return (this.options.repairHandler ?? executeDualEngineRepair)({ ...input, store: this.store });
  }

  private async prepareLocalTakeover(input: {
    taskId: string; projectRoot: string; headSha: string; findings: ReviewFinding[]; repair: DualEngineRepairResult;
  }) {
    const cloud = this.store.manager.cloudSessions.getByTaskId(input.taskId);
    if (!cloud) throw new ApplicationError('CLOUD_SESSION_NOT_FOUND', 'The Jules session disappeared before local takeover.', 409);
    const localSync = await synchronizeLocalTargetBranch({ projectRoot: input.projectRoot, targetBranch: cloud.targetBranch,
      baseSha: cloud.baseSha, headSha: input.headSha, checkoutTarget: true });
    if (!localSync.synced) {
      const message = `Jules repairs require a local takeover, but Orchestra could not prepare the target branch: ${localSync.reason}`;
      this.store.updateTask(input.taskId, { state: 'review_disputed', error: message });
      this.store.manager.julesCapacity.release(input.taskId);
      this.store.addEvent(input.taskId, 'orchestra', 'task.review-disputed', { message, reason: localSync.reason,
        nextAction: 'Preserve or commit the local changes, check out the target branch, then retry the Jules review handoff.' });
      return { ok: false, stage: 'review_disputed', headSha: input.headSha, repair: input.repair, localSync };
    }

    const findings = input.findings.map((finding) => `${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}: ` : ''}${finding.explanation}`).join('\n');
    const message = `Jules could not continue the repair remotely. Orchestra imported PR head ${input.headSha.slice(0, 8)} on ${cloud.targetBranch} and will continue locally with these independent review findings:\n${findings}`;
    const latest = this.store.manager.checkpoints.latest(input.taskId, 'local_takeover');
    if (latest?.subjectSha?.toLowerCase() !== input.headSha.toLowerCase() || latest.data.status !== 'prepared') {
      this.store.manager.checkpoints.append({ taskId: input.taskId, attemptId: cloud.attemptId, stage: 'local_takeover', subjectSha: input.headSha,
        data: { status: 'prepared', baseSha: cloud.baseSha, targetBranch: cloud.targetBranch, findings: input.findings,
          repairCycle: input.repair.cycle, localSyncMode: localSync.mode } });
    }
    this.store.updateTask(input.taskId, { target: 'local', state: 'recovery_required', error: message });
    this.store.manager.julesCapacity.release(input.taskId);
    this.store.addEvent(input.taskId, 'orchestra', 'task.takeover_local', { message, prepared: true, headSha: input.headSha,
      baseSha: cloud.baseSha, targetBranch: cloud.targetBranch, findings: input.findings,
      nextAction: 'Orchestra is queuing a local Antigravity repair on the imported Jules PR head.' });
    return { ok: false, stage: 'local_takeover', headSha: input.headSha, repair: input.repair, localSync };
  }
}
