import type { Store } from '../../db.js';
import type { ReviewFinding } from '../../domain/execution/review.js';
import type { VerificationResult } from '../../verification.js';
import { JulesApiClient } from './client.js';
import { resolveJulesApiKey } from './credentials.js';
import { redactSecrets } from './errors.js';

// ============================================================================
// Google Jules & Orchestra Dual-Engine Local/Cloud Repair Loop
// ============================================================================

export type RepairStrategy = 'cloud_feedback' | 'local_takeover' | 'escalate_dispute';

export interface RepairDecision {
  strategy: RepairStrategy;
  cycle: number;
  maxCycles: number;
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
  maxCycles?: number;
  maxCloudAttempts?: number;
  store: Store;
  julesClient?: JulesApiClient;
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
  maxCycles?: number;
  maxCloudAttempts?: number;
  isCloudSessionActive: boolean;
  findings: ReviewFinding[];
  verificationResults?: VerificationResult[];
}): RepairDecision {
  const maxCycles = options.maxCycles ?? 3;
  const maxCloudAttempts = options.maxCloudAttempts ?? 2;
  const cycle = options.cycle;

  if (cycle > maxCycles) {
    return {
      strategy: 'escalate_dispute',
      cycle,
      maxCycles,
      reason: `Maximum repair iterations (${maxCycles}) exceeded. Escalating to dispute for manual review.`,
      findings: options.findings,
    };
  }

  if (cycle <= maxCloudAttempts && options.isCloudSessionActive) {
    return {
      strategy: 'cloud_feedback',
      cycle,
      maxCycles,
      reason: `Sending structured review feedback to Jules cloud worker (cycle ${cycle}/${maxCloudAttempts}).`,
      findings: options.findings,
    };
  }

  return {
    strategy: 'local_takeover',
    cycle,
    maxCycles,
    reason: `Cloud feedback budget exhausted or session inactive. Taking over locally with Antigravity for cycle ${cycle}.`,
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
    julesClient,
    onEvent,
  } = options;

  const maxCycles = options.maxCycles ?? 3;
  const maxCloudAttempts = options.maxCloudAttempts ?? 2;

  // 1. Determine current cycle from existing attempts
  const attempts = store.manager.attempts.listByTaskId(taskId);
  const cycle = options.cycle ?? (attempts.length + 1);

  // 2. Check cloud session state
  const cloudSession = store.manager.cloudSessions.getByRemoteSessionId(remoteSessionId);
  const isCloudSessionActive = Boolean(
    cloudSession &&
    cloudSession.state !== 'CANCELLED' &&
    cloudSession.state !== 'FAILED'
  );

  // 3. Evaluate dynamic repair strategy
  const decision = evaluateRepairStrategy({
    cycle,
    maxCycles,
    maxCloudAttempts,
    isCloudSessionActive,
    findings,
    verificationResults,
  });

  // 4. Case: Escalate to Dispute
  if (decision.strategy === 'escalate_dispute') {
    store.updateTask(taskId, { state: 'review_disputed' });
    store.addEvent(taskId, 'orchestra', 'task.disputed', {
      cycle,
      maxCycles,
      reason: decision.reason,
      findingsCount: findings.length,
    });
    store.manager.julesCapacity.release(taskId);
    onEvent?.({
      name: 'task.disputed',
      payload: { taskId, cycle, reason: decision.reason },
    });
    return {
      strategy: 'escalate_dispute',
      ok: false,
      cycle,
      error: decision.reason,
    };
  }

  // 5. Case: Cloud Feedback
  if (decision.strategy === 'cloud_feedback') {
    let client = julesClient;
    if (!client) {
      const { apiKey } = resolveJulesApiKey();
      if (!apiKey) {
        throw new Error('JULES_API_KEY is not configured for cloud feedback.');
      }
      client = new JulesApiClient({ apiKey });
    }

    const feedbackMessage = formatRepairFeedbackPrompt(findings, verificationResults);

    try {
      await client.sendMessage(remoteSessionId, feedbackMessage);
    } catch {
      // Fallback to local takeover if cloud feedback fails
      return executeDualEngineRepair({
        ...options,
        cycle,
        maxCloudAttempts: 0, // Force local takeover
      });
    }

    // Record new execution attempt
    const attempt = store.manager.attempts.create({
      taskId,
      target: 'cloud',
      worker: 'jules',
      baseSha,
      providerSessionId: remoteSessionId,
      state: 'WORKING',
    });

    // Update cloud session state & task state
    if (cloudSession) {
      store.manager.cloudSessions.update(cloudSession.id, { state: 'IN_PROGRESS' });
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
      attemptId: attempt.id,
    });

    onEvent?.({
      name: 'cloud.repair_requested',
      payload: { taskId, remoteSessionId, cycle, attemptId: attempt.id },
    });

    return {
      strategy: 'cloud_feedback',
      ok: true,
      cycle,
      attemptId: attempt.id,
    };
  }

  // 6. Case: Local Takeover with Antigravity
  const attempt = store.manager.attempts.create({
    taskId,
    target: 'local',
    worker: 'antigravity',
    baseSha,
    state: 'WORKING',
  });

  store.updateTask(taskId, { state: 'running', target: 'local' });

  store.addEvent(taskId, 'orchestra', 'task.takeover_local', {
    cycle,
    reason: decision.reason,
    headSha,
    baseSha,
    findingsCount: findings.length,
    attemptId: attempt.id,
  });

  onEvent?.({
    name: 'task.takeover_local',
    payload: { taskId, cycle, attemptId: attempt.id, reason: decision.reason },
  });

  return {
    strategy: 'local_takeover',
    ok: true,
    cycle,
    attemptId: attempt.id,
  };
}
