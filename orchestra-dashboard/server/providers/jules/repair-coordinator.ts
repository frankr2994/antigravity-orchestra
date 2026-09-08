import type { Store } from '../../db.js';
import type { ReviewFinding } from '../../domain/execution/review.js';
import type { VerificationResult } from '../../verification.js';
import { redactSecrets } from './errors.js';
import { createHash } from 'node:crypto';
import { parseJulesOutstandingRepair, type JulesOutstandingRepair } from '../../domain/index.js';

// ============================================================================
// Google Jules & Orchestra Dual-Engine Local/Cloud Repair Loop
// ============================================================================

export type RepairStrategy = 'cloud_feedback' | 'local_takeover';

export interface RepairDecision {
  strategy: RepairStrategy;
  cycle: number;
  reason: string;
  findings: ReviewFinding[];
}

export interface DualEngineRepairOptions {
  taskId: string;
  projectRoot: string;
  remoteSessionId: string;
  baseSha: string;
  headSha?: string;
  findings: ReviewFinding[];
  verificationResults?: VerificationResult[];
  cycle?: number;
  store: Store;
  sessionService?: { sendRepairFeedback(taskId: string, prompt: string, idempotencyKey: string): Promise<unknown> };
  onEvent?: (event: { name: string; payload: unknown }) => void;
}

export interface DualEngineRepairResult {
  strategy: RepairStrategy;
  ok: boolean;
  cycle: number;
  attemptId?: string;
  error?: string;
}

export function evaluateRepairStrategy(options: {
  cycle: number;
  isCloudSessionActive: boolean;
  findings: ReviewFinding[];
  verificationResults?: VerificationResult[];
}): RepairDecision {
  const cycle = options.cycle;

  if (options.isCloudSessionActive) {
    return {
      strategy: 'cloud_feedback',
      cycle,
      reason: `Sending structured review feedback to Jules cloud worker for repair cycle ${cycle}.`,
      findings: options.findings,
    };
  }

  return {
    strategy: 'local_takeover',
    cycle,
    reason: `The Jules session is inactive. Taking over locally with Antigravity for repair cycle ${cycle}.`,
    findings: options.findings,
  };
}

export function formatRepairFeedbackPrompt(
  findings: ReviewFinding[],
  verificationResults?: VerificationResult[]
): string {
  const lines = [
    'The independent Codex review found issues with the proposed changes that must be resolved:',
    '',
  ];

  if (findings.length > 0) {
    lines.push('### Required Fixes:');
    for (const f of findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      lines.push(`- [${f.severity.toUpperCase()}]${loc}: ${f.explanation}`);
    }
    lines.push('');
  }

  if (verificationResults && verificationResults.some((v) => v.code !== 0)) {
    lines.push('### Verification Failures:');
    for (const v of verificationResults.filter((r) => r.code !== 0)) {
      lines.push(`- Command: \`${v.command}\` exited with code ${v.code}`);
      lines.push('```');
      lines.push(redactSecrets(v.output).slice(-2000));
      lines.push('```');
    }
    lines.push('');
  }

  lines.push('Please apply the requested fixes and update the Pull Request branch.');
  return lines.join('\n');
}

export async function executeDualEngineRepair(
  options: DualEngineRepairOptions
): Promise<DualEngineRepairResult> {
  const {
    taskId,
    remoteSessionId,
    baseSha,
    headSha,
    findings,
    verificationResults,
    store,
    onEvent,
  } = options;

  // 1. Determine current cycle from existing attempts
  const attempts = store.manager.attempts.listByTaskId(taskId);
  const cloudSession = store.manager.cloudSessions.getByRemoteSessionId(remoteSessionId);
  const repairAttempts = attempts.filter((attempt) => attempt.worker === 'jules' && attempt.id !== cloudSession?.attemptId);
  const cycle = options.cycle ?? (repairAttempts.length + 1);

  // 2. Check cloud session state
  // A completed session can still be retained for audit and PR handoff, but it
  // cannot apply a repair.  Treating it as live here was the source of the
  // retry storm: each terminal poll re-entered the cloud-feedback path even
  // after Jules had acknowledged the packet and exited without a new head.
  // Only states in which the provider can still consume a command are cloud
  // repair-capable.  A completed/failed/cancelled worker is the explicit,
  // durable signal required before a local takeover is allowed.
  const isCloudSessionActive = Boolean(
    cloudSession && ['QUEUED', 'IN_PROGRESS', 'AWAITING_USER_FEEDBACK', 'PAUSED'].includes(cloudSession.state)
  );

  // 3. Evaluate dynamic repair strategy
  const decision = evaluateRepairStrategy({
    cycle,
    isCloudSessionActive,
    findings,
    verificationResults,
  });

  // 4. Case: Cloud Feedback
  if (decision.strategy === 'cloud_feedback') {
    const feedbackMessage = formatRepairFeedbackPrompt(findings, verificationResults);
    const findingsFingerprint = createHash('sha256').update(JSON.stringify({ findings,
      verificationResults: verificationResults?.map((item) => ({ command: item.command, code: item.code, output: redactSecrets(item.output).slice(-2_000) })) || [] })).digest('hex');
    if (!headSha || !/^[a-f0-9]{40,64}$/i.test(headSha)) throw new Error('A valid reviewed PR head is required before repair feedback.');
    const repairId = createHash('sha256').update(`${taskId}:${headSha.toLowerCase()}:${findingsFingerprint}`).digest('hex');
    const feedbackCommandKey = `jules-repair:${repairId}`;
    const priorCheckpoint = store.manager.checkpoints.latest(taskId, 'jules_outstanding_repair');
    if (priorCheckpoint) {
      let prior: JulesOutstandingRepair;
      try { prior = parseJulesOutstandingRepair(priorCheckpoint.data); }
      catch { throw new Error('Persisted Jules repair automation state is malformed; repair feedback is blocked.'); }
      if (prior.repairId === repairId && ['feedback_acknowledged', 'awaiting_new_head'].includes(prior.status)) {
        store.addEvent(taskId, 'orchestra', 'cloud.waiting_for_head', { headSha, repairId, findingsFingerprint,
          message: 'The repair feedback is acknowledged; Orchestra is waiting for a different PR head.' });
        return { strategy: 'cloud_feedback', ok: true, cycle };
      }
    }
    if (!options.sessionService) throw new Error('Durable JulesSessionService is required for repair feedback.');
    const pending: JulesOutstandingRepair = { version: 1, taskId, headSha: headSha.toLowerCase(), findingsFingerprint, repairId,
      feedbackCommandKey, status: 'pending', acknowledgedAt: null, createdAt: new Date().toISOString() };
    store.manager.checkpoints.append({ taskId, attemptId: cloudSession?.attemptId, stage: 'jules_outstanding_repair', subjectSha: headSha,
      data: pending as unknown as Record<string, unknown> });

    try {
      await options.sessionService.sendRepairFeedback(taskId, feedbackMessage, feedbackCommandKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.addEvent(taskId, 'orchestra', 'warning', { code: 'JULES_REPAIR_FEEDBACK_UNCONFIRMED',
        message: `Repair feedback acknowledgement is unresolved; Orchestra will reconcile it without resending or taking over locally: ${message}` });
      return { strategy: 'cloud_feedback', ok: false, cycle, error: message };
    }

    const acknowledged: JulesOutstandingRepair = { ...pending, status: 'awaiting_new_head', acknowledgedAt: new Date().toISOString() };
    store.manager.checkpoints.append({ taskId, attemptId: cloudSession?.attemptId, stage: 'jules_outstanding_repair', subjectSha: headSha,
      data: acknowledged as unknown as Record<string, unknown> });
    if (cloudSession) {
      const cursor = store.manager.activityCursors.ensure(cloudSession.id);
      store.manager.activityCursors.compareAndSet(cloudSession.id, cursor.version, {
        nextPollAt: new Date().toISOString(), consecutiveFailures: 0, lastErrorCode: null,
        lastActivityId: cursor.lastActivityId, lastActivityAt: cursor.lastActivityAt,
      });
    }
    store.updateTask(taskId, { state: 'running' });

    store.addEvent(taskId, 'jules', 'cloud.repair_requested', {
      remoteSessionId,
      cycle,
      findingsCount: findings.length,
      repairId,
      headSha,
    });

    onEvent?.({
      name: 'cloud.repair_requested',
      payload: { taskId, remoteSessionId, cycle, repairId, headSha },
    });

    return {
      strategy: 'cloud_feedback',
      ok: true,
      cycle,
    };
  }

  // 5. Case: request a real local takeover. The review service must first
  // synchronize the exact reviewed head locally, then queue an executor.
  store.addEvent(taskId, 'orchestra', 'task.takeover_local', {
    cycle,
    reason: decision.reason,
    headSha,
    baseSha,
    findingsCount: findings.length,
    prepared: false,
  });

  onEvent?.({
    name: 'task.takeover_local',
    payload: { taskId, cycle, reason: decision.reason },
  });

  return {
    strategy: 'local_takeover',
    ok: true,
    cycle,
  };
}
