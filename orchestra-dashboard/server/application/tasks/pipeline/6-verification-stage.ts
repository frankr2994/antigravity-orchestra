import { getChangedFilesFromBase, getDiff, getDiffFromBase, getGitStatus } from '../../../git.js';
import { isOrchestraInternalPath } from '../../../projects.js';
import { verifyProject, verificationFailure as describeVerificationFailure, type VerificationResult } from '../../../verification.js';
import type { PipelineContext } from './types.js';

export interface VerificationStageResult {
  diff: string;
  changedFiles: string[];
  verificationPassed: boolean;
  verificationFailureText?: string;
  verificationResults: VerificationResult[];
}

/**
 * Stage 6: Deterministic Local Verification & Change Inspection
 * Checks for concrete file modifications and runs the project's native
 * test and build scripts before spending any AI review tokens.
 */
export async function runVerificationStage(
  ctx: PipelineContext,
  baseSha: string | null
): Promise<VerificationStageResult> {
  const currentStatus = await getGitStatus(ctx.project.root);
  const changedFiles = (baseSha
    ? await getChangedFilesFromBase(ctx.project.root, baseSha)
    : currentStatus.files.map((f) => f.path)
  ).filter((p) => !isOrchestraInternalPath(p));

  // Circuit Breaker: Zero-diff detection (no infinite loops)
  if (changedFiles.length === 0) {
    if (ctx.recovery && (ctx.task.commitSha || !currentStatus.dirty)) {
      ctx.emit('verification', 'warning', {
        message: 'Recovery detected clean workspace or existing commit; bypassing zero-diff circuit breaker.',
      });
      return {
        diff: '',
        changedFiles: [],
        verificationPassed: true,
        verificationResults: [],
      };
    }
    ctx.emit('system', 'task.no-changes', {
      message: 'Antigravity completed its turn without modifying any project files. This may happen when the request requires clarification. Review output and refine or retry.',
    });
    throw new Error('Antigravity completed its turn without modifying any project files. The task has paused so you can refine your request.');
  }

  const diff = baseSha
    ? await getDiffFromBase(ctx.project.root, baseSha)
    : await getDiff(ctx.project.root);

  // Deterministic local verification runner
  let verificationFailureText = '';
  let verificationResults: VerificationResult[] = [];
  try {
    verificationResults = await verifyProject(ctx.project.root, ctx.signal);
    ctx.emit('verification', 'verification.result', { results: verificationResults });
    verificationFailureText = describeVerificationFailure(verificationResults);
  } catch (error) {
    verificationFailureText = error instanceof Error ? error.message : String(error);
    ctx.emit('verification', 'warning', {
      message: `Verification infrastructure warning: ${verificationFailureText}`,
    });
  }

  return {
    diff,
    changedFiles,
    verificationPassed: !verificationFailureText,
    verificationFailureText: verificationFailureText || undefined,
    verificationResults,
  };
}
