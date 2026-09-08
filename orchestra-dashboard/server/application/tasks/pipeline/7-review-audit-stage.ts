import { condenseDiff } from '../../gemma/diff-condenser-service.js';
import { compactHeadAndTail } from '../../gemma/context-budget.js';
import {
  buildReviewPacket,
  extractCodexReviewVerdict,
  extractReviewFindings,
  detectReviewLoop,
  type ReviewTriage,
  type ReviewCycleRecord,
} from '../../review/review-services.js';
import { selectReviewProfile } from '../../routing/model-policy.js';
import { runCodexReview } from '../../../providers/codex/agent-adapter.js';
import { runAntigravity } from '../../../providers/antigravity/agent-adapter.js';
import { getDiff, getDiffFromBase, getGitStatus, getChangedFilesFromBase } from '../../../git.js';
import { isOrchestraInternalPath } from '../../../projects.js';
import { verifyProject, verificationFailure as describeVerificationFailure } from '../../../verification.js';
import { distillVerificationErrors } from '../../review/review-services.js';
import { createHash } from 'node:crypto';
import { runRipwireQualityDelta, runRipwireTestGate, runRipwireSitu } from '../../../ripwire.js';
import type { PipelineContext } from './types.js';

export interface ReviewAuditStageResult {
  passed: boolean;
  cyclesCompleted: number;
  finalDiff: string;
  finalChangedFiles: string[];
  finalReviewText?: string;
}

function diffFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isCodexCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /usage limit|quota|credits|rate limit|at capacity|overloaded|try again at/i.test(message);
}

/**
 * Stage 7: Diff Condensation & Codex Auditor Review Gate
 * Pre-packages clean annotated diffs, executes a single-pass review gate,
 * and uses intelligent loop detection (identifying stagnant repairs, oscillation,
 * and unresolved blockers without an arbitrary repair-count ceiling.
 */
export async function runReviewAuditStage(
  ctx: PipelineContext,
  baseSha: string | null,
  initialImplementationSummary: string
): Promise<ReviewAuditStageResult> {
  const reviewBaseSha = baseSha || ctx.status.head;
  const cycleHistory: ReviewCycleRecord[] = [];
  let previousFindings = '';
  let previousReview = '';
  let previousRepairChanged = true;
  let lastReviewedDiff = '';
  let lastReview = '';
  let verificationPassed = false;
  let latestSummary = initialImplementationSummary;
  let finalDiff = '';
  let finalChangedFiles: string[] = [];
  let cyclesCompleted = 0;

  for (let cycle = 0; !verificationPassed; cycle += 1) {
    if (ctx.signal.aborted) break;
    cyclesCompleted = cycle + 1;

    const reviewStatus = await getGitStatus(ctx.project.root);
    const changedFiles = (reviewBaseSha
      ? await getChangedFilesFromBase(ctx.project.root, reviewBaseSha)
      : reviewStatus.files.map((f) => f.path)
    ).filter((p) => !isOrchestraInternalPath(p));

    const diff = reviewBaseSha
      ? await getDiffFromBase(ctx.project.root, reviewBaseSha, 80_000)
      : await getDiff(ctx.project.root, 80_000);

    finalDiff = diff;
    finalChangedFiles = changedFiles;
    const currentDiffFingerprint = diffFingerprint(diff);

    if (!changedFiles.length || !diff.trim()) {
      if (ctx.recovery && (ctx.task.commitSha || !reviewStatus.dirty)) {
        ctx.emit('system', 'task.recovery', {
          message: 'Recovery detected clean workspace or existing commit; skipping review cycle.',
        });
        return {
          passed: true,
          cyclesCompleted: 0,
          finalDiff: '',
          finalChangedFiles: [],
          finalReviewText: 'Recovery passed: clean workspace or existing commit.',
        };
      }
      throw new Error('Orchestra could not construct a reviewable change set after implementation.');
    }

    ctx.transition('verifying');

    // 1. Deterministic Verification
    let verificationFailure = '';
    let verification: Array<{ command: string; code: number; output: string }> = [];
    try {
      verification = await verifyProject(ctx.project.root, ctx.signal);
      ctx.emit('verification', 'verification.result', { results: verification });
      verificationFailure = describeVerificationFailure(verification);
    } catch (error) {
      verificationFailure = error instanceof Error ? error.message : String(error);
      ctx.emit('verification', 'warning', {
        message: `Verification warning before review: ${verificationFailure}`,
      });
    }

    let review = '';
    let blocked = true;

    if (verificationFailure) {
      const failedItem = verification.find((item) => item.code !== 0);
      const failedCmd = failedItem?.command || 'verification';
      ctx.emit('gemma', 'agent.started', { phase: 'verification-distillation', command: failedCmd });
      const distilled = await distillVerificationErrors(verificationFailure, failedCmd);
      ctx.emit('gemma', 'agent.completed', { phase: 'verification-distillation', summary: distilled.summary, findingCount: distilled.findings.length });
      review = `VERDICT: BLOCK\n\nDeterministic verification failed before independent review.\n\n${distilled.repairPromptChunk}`;
      ctx.emit('system', 'task.model-takeover', {
        message: `Deterministic verification failed before Codex review. Gemma distilled ${distilled.findings.length} failure findings.`,
        from: 'verification',
        to: 'antigravity-repair',
        cycle: cycle + 1,
      });
    } else if (currentDiffFingerprint === lastReviewedDiff && lastReview) {
      review = lastReview;
      blocked = extractCodexReviewVerdict(review).blocked;
      ctx.emit('system', 'routing.adjustment', {
        message: 'The verified diff is unchanged since previous review. Reused that review.',
        reviewReused: true,
      });
    } else {
      // 2. Diff Condensation & Contract Drift Detection (Pass 7)
      let condensedDiff = diff;
      let triage: ReviewTriage = { risk: 'normal', summary: 'Review the bounded diff directly.', focusFiles: [], concerns: [] };
      ctx.emit('gemma', 'agent.started', { phase: 'diff-condensation', cycle: cycle + 1, changedFiles: changedFiles.length });

      try {
        const condensed = await condenseDiff({
          diff,
          changedFiles,
          refinedSpec: ctx.refinedSpec,
          implementationSummary: latestSummary,
          onUsage: (usage) => ctx.recordLocalProviderTelemetry(usage),
        });
        condensedDiff = condensed.authoritativeDiff;
        triage = {
          risk: condensed.riskFlags.some((f) => /critical|security|drift/i.test(f)) ? 'high' : condensed.riskFlags.length ? 'normal' : 'low',
          summary: condensed.annotations,
          focusFiles: changedFiles.filter((f) => !condensed.strippedPaths.includes(f)).slice(0, 20),
          concerns: condensed.riskFlags,
        };
        ctx.emit('gemma', 'agent.completed', {
          phase: 'diff-condensation',
          cycle: cycle + 1,
          risk: triage.risk,
          strippedPaths: condensed.strippedPaths.length,
          concerns: triage.concerns,
        });
      } catch (error) {
        ctx.emit('gemma', 'warning', {
          message: `Diff condensation warning: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // 3. Codex Auditor Review Gate
      const profile = selectReviewProfile({
        request: ctx.task.prompt,
        cycle,
        changedFileCount: changedFiles.length,
        triageRisk: triage.risk,
        repeatedFindings: cycle > 0 && !previousRepairChanged,
        codexRemaining: ctx.capabilities.codex.rollingQuotaRemaining,
      });

      // Collect Ripwire deterministic review analysis (quality regressions, test gate, blast radius)
      // to keep Codex focused on verified evidence without exploring the repo with expensive tool calls.
      let ripwireReviewContext: { qualityDelta?: string; testGate?: string; situ?: string } | undefined;
      if (ctx.capabilities?.ripwire?.available) {
        try {
          const [qdResult, tgResult, situResult] = await Promise.allSettled([
            runRipwireQualityDelta(ctx.project.root, ctx.signal),
            runRipwireTestGate(ctx.project.root, ctx.signal),
            runRipwireSitu(ctx.project.root, ctx.signal),
          ]);
          ripwireReviewContext = {
            qualityDelta: qdResult.status === 'fulfilled' && qdResult.value ? qdResult.value.output : undefined,
            testGate: tgResult.status === 'fulfilled' && tgResult.value ? tgResult.value.output : undefined,
            situ: situResult.status === 'fulfilled' && situResult.value ? situResult.value.output : undefined,
          };
          if (qdResult.status === 'fulfilled' && qdResult.value) {
            ctx.emit('system', 'ripwire.context', { phase: 'review', kind: 'quality-delta', estimatedTokens: qdResult.value.estimatedTokens });
          }
        } catch { /* degradable */ }
      }

      const reviewPacket = buildReviewPacket({
        request: ctx.task.prompt,
        changedFiles,
        diff: condensedDiff,
        implementationSummary: latestSummary,
        triage,
        previousReview,
        ripwire: ripwireReviewContext,
      });

      ctx.transition('reviewing');
      ctx.emit('codex', 'agent.started', {
        role: 'review',
        model: profile.model,
        effort: profile.effort,
        cycle: cycle + 1,
        changedFiles: changedFiles.length,
      });

      const runReview = (model: string, effort: 'low' | 'medium' | 'high') => runCodexReview({
        root: ctx.project.root, model, effort, reviewPacket,
        riderAvailable: ctx.riderFor('codex'), signal: ctx.signal,
        onOutput: (chunk) => ctx.stream('codex', chunk),
        onUsage: (usage) => ctx.recordProviderTelemetry('codex', usage),
      });
      try {
        review = await runReview(profile.model, profile.effort);
      } catch (error) {
        // Capacity fallback always moves down the ladder.  It never retries a
        // more expensive tier merely because the selected tier is unavailable.
        if (!isCodexCapacityError(error) || profile.model === 'gpt-5.6-luna') throw error;
        ctx.emit('system', 'routing.adjustment', {
          message: `Codex ${profile.model} is unavailable; retrying the same bounded review with Luna Low.`,
          fromModel: profile.model, toModel: 'gpt-5.6-luna', reason: 'capacity_fallback',
        });
        review = await runReview('gpt-5.6-luna', 'low');
      }

      lastReviewedDiff = currentDiffFingerprint;
      lastReview = review;
      const reviewResult = extractCodexReviewVerdict(review);
      blocked = reviewResult.blocked;

      ctx.emit('codex', 'agent.completed', {
        role: 'review',
        blocked,
        verdict: reviewResult.verdict,
        model: profile.model,
        cycle: cycle + 1,
        summary: review.slice(-5000),
      });

      if (!blocked) {
        verificationPassed = true;
        break;
      }
    }

    // 4. Intelligent Loop Evaluation
    const findingsList = extractReviewFindings(review);
    const findingsFp = diffFingerprint(findingsList.map((f) => f.signature).sort().join('|') || review);
    cycleHistory.push({
      cycle: cycle + 1,
      diffFingerprint: currentDiffFingerprint,
      findings: findingsList,
      findingsFingerprint: findingsFp,
      diffChangedSinceLastCycle: previousRepairChanged,
    });

    const loopCheck = detectReviewLoop(cycleHistory);
    if (loopCheck.isLoop) {
      ctx.emit('system', 'task.review-cap', {
        message: `Review loop detected: ${loopCheck.reason}. Preserving changes for manual inspection.`,
        loopDetected: true,
        reason: loopCheck.reason,
      });
      ctx.transition('review_disputed');
      return { passed: false, cyclesCompleted: cycle + 1, finalDiff, finalChangedFiles, finalReviewText: lastReview };
    }

    // 5. Automatic Repair Cycle.  A changing diff with changing findings is
    // forward progress, not a reason to demand manual continuation.
    {
      const repeatedWithoutProgress = Boolean(previousFindings && findingsFp === previousFindings && !previousRepairChanged);
      const beforeRepair = diffFingerprint(reviewBaseSha ? await getDiffFromBase(ctx.project.root, reviewBaseSha) : await getDiff(ctx.project.root));

      // Ripwire: enrich the repair prompt with quality regressions and test targeting.
      // --quality-delta says what we broke; --test-gate says exactly which tests to run.
      // Both save Antigravity from re-grepping everything during the repair turn.
      let ripwireRepairContext = '';
      if (ctx.capabilities?.ripwire?.available) {
        try {
          const [qdResult, tgResult] = await Promise.allSettled([
            runRipwireQualityDelta(ctx.project.root, ctx.signal),
            runRipwireTestGate(ctx.project.root, ctx.signal),
          ]);
          const parts: string[] = [];
          if (qdResult.status === 'fulfilled' && qdResult.value) {
            const boundedQd = compactHeadAndTail(qdResult.value.output, 4_000, 'Ripwire quality delta');
            parts.push(`## Ripwire quality delta (regressions introduced by this change)\n${boundedQd}`);
            ctx.emit('system', 'ripwire.context', { phase: 'repair', kind: 'quality-delta', estimatedTokens: qdResult.value.estimatedTokens });
          }
          if (tgResult.status === 'fulfilled' && tgResult.value) {
            const boundedTg = compactHeadAndTail(tgResult.value.output, 2_000, 'Ripwire test gate');
            parts.push(`## Ripwire test gate (minimal tests to run for changed files)\n${boundedTg}`);
          }
          ripwireRepairContext = parts.length ? `\n\n${parts.join('\n\n')}` : '';
        } catch { /* degradable */ }
      }

      ctx.transition('running');
      const boundedReview = compactHeadAndTail(review, 8_000, 'Codex review');
      const repairResult = await runAntigravity({
        root: ctx.project.root,
        prompt: `Address every blocking finding in this Codex review, then rerun relevant verification. ${repeatedWithoutProgress ? 'Use a different implementation approach in this fresh turn. ' : ''}\n\n${boundedReview}${ripwireRepairContext}`,
        model: ctx.models.antigravity,
        effort: 'high',
        mutating: true,
        conversationId: repeatedWithoutProgress ? null : ctx.session.antigravityConversationId,
        riderAvailable: ctx.riderFor('antigravity'),
        signal: ctx.signal,
        onOutput: (chunk) => ctx.stream('antigravity', chunk),
        onUsage: (usage) => ctx.recordProviderTelemetry('antigravity', usage),
      });

      latestSummary = repairResult.text;
      const afterRepair = diffFingerprint(reviewBaseSha ? await getDiffFromBase(ctx.project.root, reviewBaseSha) : await getDiff(ctx.project.root));
      previousRepairChanged = beforeRepair !== afterRepair;
      previousFindings = findingsFp;
      previousReview = review;
      ctx.emit('system', 'task.repair-progress', { attempt: cycle + 1, changed: previousRepairChanged });
    }
  }

  if (!verificationPassed) {
    ctx.emit('system', 'task.review-cap', {
      message: 'Review stopped before a passing verdict. Changes were preserved for manual inspection.',
    });
    ctx.transition('review_disputed');
    return { passed: false, cyclesCompleted, finalDiff, finalChangedFiles, finalReviewText: lastReview };
  }

  return { passed: true, cyclesCompleted, finalDiff, finalChangedFiles, finalReviewText: lastReview };
}
