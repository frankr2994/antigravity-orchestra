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
      const due = this.options.store.manager.activityCursors.listDue(new Date().toISOString(), 100);
      const limit = Math.max(1, Math.min(32, this.options.maxConcurrentPolls ?? 2));
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < due.length) {
          const cursor = due[nextIndex++];
          const session = this.options.store.manager.cloudSessions.getById(cursor.cloudSessionId);
          if (!session || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(session.state)) continue;
          const lease = this.options.store.manager.leases.acquire('jules_poll', session.id, this.ownerId, this.options.leaseDurationMs ?? 30_000);
          if (!lease) continue;
          try {
            const result = await this.options.sessionManager.pollSession(session.remoteSessionId, {
              julesClient: this.options.julesClient, lease: { ownerId: this.ownerId, fencingToken: lease.fencingToken },
            });
            polled += 1;
            if (!result.ok) { errors += 1; continue; }
            if (result.isTerminal) {
              const prOutput = result.julesSession?.outputs?.find((output) => output.pullRequest?.url)?.pullRequest;
              await this.options.onTerminal?.({ taskId: session.taskId, remoteSessionId: session.remoteSessionId,
                state: String(result.julesState || 'COMPLETED'), prUrl: prOutput?.url });
            }
          } catch (caught) {
            errors += 1;
            this.options.onError?.(caught instanceof Error ? caught : new Error(String(caught)), session);
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
}
