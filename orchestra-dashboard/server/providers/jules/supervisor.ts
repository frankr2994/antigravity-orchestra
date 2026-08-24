import type { Store } from '../../db.js';
import type { CloudSessionReference } from '../../domain/index.js';
import type { JulesApiClient } from './client.js';
import { JulesSessionManager } from './session-manager.js';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Google Jules Background Cloud Supervisor & Distributed Polling Loop
// ============================================================================

export interface JulesSupervisorOptions {
  store: Store;
  sessionManager: JulesSessionManager;
  julesClient?: JulesApiClient;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  maxConcurrentPolls?: number;
  isEnabled?: () => boolean;
  reconcile?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  onTerminal?: (event: {
    taskId: string;
    remoteSessionId: string;
    state: string;
    prUrl?: string | null;
    prHeadSha?: string | null;
  }) => Promise<void> | void;
  onError?: (error: Error, session?: CloudSessionReference) => void;
}

export interface SupervisorTickResult {
  polled: number;
  active: number;
  errors: number;
}

export class JulesSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isTickInProgress = false;
  private abortController: AbortController | null = null;
  private readonly ownerId = `jules-supervisor-${randomUUID()}`;

  constructor(private readonly options: JulesSupervisorOptions) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    const interval = this.options.pollIntervalMs ?? 5_000;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onError?.(error);
      });
    }, interval);
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async tick(): Promise<SupervisorTickResult> {
    if (this.options.isEnabled && !this.options.isEnabled()) return { polled: 0, active: 0, errors: 0 };
    if (this.isTickInProgress) {
      return { polled: 0, active: 0, errors: 0 };
    }

    this.isTickInProgress = true;
    let polled = 0; let errors = 0;
    try {
      await this.options.reconcile?.();
      const nonTerminalSessions = this.options.store.manager.cloudSessions.listNonTerminal();
      for (const session of nonTerminalSessions) this.options.store.manager.activityCursors.ensure(session.id);
      const pendingIntegration = this.options.store.manager.cloudSessions.listPendingIntegration();
      for (const session of pendingIntegration) {
        const cursor = this.options.store.manager.activityCursors.ensure(session.id);
        if (cursor.nextPollAt.startsWith('9999-')) {
          try {
            this.options.store.manager.activityCursors.compareAndSet(session.id, cursor.version, {
              nextPollAt: new Date().toISOString(), consecutiveFailures: cursor.consecutiveFailures,
              lastErrorCode: cursor.lastErrorCode, lastActivityId: cursor.lastActivityId, lastActivityAt: cursor.lastActivityAt,
            });
          } catch { /* Another supervisor already scheduled the durable handoff. */ }
        }
      }
      const due = this.options.store.manager.activityCursors.listDue(new Date().toISOString(), 100);
      const limit = Math.max(1, Math.min(32, this.options.maxConcurrentPolls ?? 2));
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < due.length) {
          const cursor = due[nextIndex++];
          const session = this.options.store.manager.cloudSessions.getById(cursor.cloudSessionId);
          if (!session || ['FAILED', 'CANCELLED'].includes(session.state)) continue;
          const lease = this.options.store.manager.leases.acquire('jules_poll', session.id, this.ownerId, this.options.leaseDurationMs ?? 30_000);
          if (!lease) continue;
          try {
            if (session.state === 'COMPLETED') {
              let prUrl = session.prUrl;
              let prHeadSha = session.prHeadSha;
              if (!prUrl) {
                const refreshed = await this.options.sessionManager.pollSession(session.remoteSessionId, {
                  julesClient: this.options.julesClient, lease: { ownerId: this.ownerId, fencingToken: lease.fencingToken },
                });
                if (!refreshed.ok) { errors += 1; continue; }
                const prOutput = refreshed.julesSession?.outputs?.find((output) => output.pullRequest?.url)?.pullRequest;
                prUrl = prOutput?.url ?? null;
                prHeadSha = this.options.store.manager.cloudSessions.getById(session.id)?.prHeadSha ?? null;
              }
              polled += 1;
              await this.options.onTerminal?.({ taskId: session.taskId, remoteSessionId: session.remoteSessionId,
                state: session.state, prUrl, prHeadSha });
              this.scheduleAfterTerminalHandoff(session.id);
              continue;
            }
            const result = await this.options.sessionManager.pollSession(session.remoteSessionId, {
              julesClient: this.options.julesClient, lease: { ownerId: this.ownerId, fencingToken: lease.fencingToken },
            });
            polled += 1;
            if (!result.ok) { errors += 1; continue; }
            if (result.isTerminal) {
              const prOutput = result.julesSession?.outputs?.find((output) => output.pullRequest?.url)?.pullRequest;
              await this.options.onTerminal?.({ taskId: session.taskId, remoteSessionId: session.remoteSessionId,
                state: String(result.julesState || 'COMPLETED'), prUrl: prOutput?.url });
              this.scheduleAfterTerminalHandoff(session.id);
            }
          } catch (caught) {
            errors += 1;
            const error = caught instanceof Error ? caught : new Error(String(caught));
            const current = this.options.store.manager.cloudSessions.getById(session.id);
            if (current?.state === 'COMPLETED') this.scheduleTerminalRetry(current, error);
            this.options.onError?.(error, session);
          } finally {
            this.options.store.manager.leases.release('jules_poll', session.id, this.ownerId, lease.fencingToken);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, due.length) }, () => worker()));
      await this.options.cleanup?.();
      return { polled, active: nonTerminalSessions.length, errors };
    } finally {
      this.isTickInProgress = false;
    }
  }

  private scheduleAfterTerminalHandoff(cloudSessionId: string): void {
    const session = this.options.store.manager.cloudSessions.getById(cloudSessionId);
    const cursor = this.options.store.manager.activityCursors.get(cloudSessionId);
    if (!session || !cursor) return;
    const task = this.options.store.getTask(session.taskId);
    const providerContinues = !['COMPLETED', 'FAILED', 'CANCELLED'].includes(session.state);
    const workflowContinuesInCloud = task?.target === 'cloud' && !['completed', 'completed_unpushed', 'failed', 'cancelled', 'review_disputed'].includes(task.state);
    const nextPollAt = providerContinues || workflowContinuesInCloud ? new Date().toISOString() : '9999-12-31T23:59:59.999Z';
    try {
      this.options.store.manager.activityCursors.compareAndSet(cloudSessionId, cursor.version, {
        nextPollAt, consecutiveFailures: 0, lastErrorCode: null,
        lastActivityId: cursor.lastActivityId, lastActivityAt: cursor.lastActivityAt,
      });
    } catch { /* A repair request or newer owner already advanced the cursor. */ }
  }

  private scheduleTerminalRetry(session: CloudSessionReference, error: Error): void {
    const cursor = this.options.store.manager.activityCursors.get(session.id);
    if (!cursor) return;
    const code = typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code?: string }).code) : null;
    const needsUserAction = code !== null && [
      'INVALID_PR_IDENTITY', 'PR_REPOSITORY_MISMATCH', 'INVALID_BASE_SHA', 'PR_BASE_MISMATCH',
      'TARGET_BRANCH_MOVED', 'GIT_REPOSITORY_UNAVAILABLE',
    ].includes(code);
    if (needsUserAction) {
      try {
        this.options.store.manager.activityCursors.compareAndSet(session.id, cursor.version, {
          nextPollAt: '9999-12-31T23:59:59.999Z', consecutiveFailures: cursor.consecutiveFailures + 1,
          lastErrorCode: code, lastActivityId: cursor.lastActivityId, lastActivityAt: cursor.lastActivityAt,
        });
      } catch { return; }
      const task = this.options.store.getTask(session.taskId);
      if (task && !['completed', 'completed_unpushed', 'failed', 'cancelled', 'review_disputed'].includes(task.state)) {
        const message = `Jules PR handoff needs attention: ${error.message}`;
        this.options.store.updateTask(task.id, { state: 'review_disputed', error: message });
        this.options.store.manager.julesCapacity.release(task.id);
        this.options.store.addEvent(task.id, 'jules', 'warning', { message, code,
          nextAction: code === 'TARGET_BRANCH_MOVED'
            ? 'Review the target branch changes, reconcile them with the Jules PR, then retry review.'
            : 'Inspect the PR and repository identity details, correct the mismatch, then retry review.' });
      }
      return;
    }
    const failures = cursor.consecutiveFailures + 1;
    const delay = Math.min(15 * 60_000, 15_000 * (2 ** Math.min(failures - 1, 6)));
    try {
      this.options.store.manager.activityCursors.compareAndSet(session.id, cursor.version, {
        nextPollAt: new Date(Date.now() + delay).toISOString(), consecutiveFailures: failures,
        lastErrorCode: 'JULES_TERMINAL_HANDOFF_FAILED', lastActivityId: cursor.lastActivityId, lastActivityAt: cursor.lastActivityAt,
      });
    } catch { return; }
    const message = `Local Jules PR handoff failed and will retry automatically in ${Math.ceil(delay / 1000)} seconds. ${error.message}`;
    const task = this.options.store.getTask(session.taskId);
    if (task && !['completed', 'completed_unpushed', 'failed', 'cancelled', 'review_disputed'].includes(task.state)) {
      this.options.store.updateTask(task.id, { state: 'reviewing', error: message });
      this.options.store.addEvent(task.id, 'jules', 'warning', {
        message,
        code: 'JULES_TERMINAL_HANDOFF_FAILED',
        nextAction: 'No duplicate dispatch is needed. Orchestra will retry the exact PR handoff automatically.',
      });
    }
  }
}
