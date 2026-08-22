import type { Store } from '../../db.js';
import type { CloudSessionReference } from '../../domain/index.js';
import type { JulesApiClient } from './client.js';
import { JulesSessionManager } from './session-manager.js';

// ============================================================================
// Google Jules Background Cloud Supervisor & Distributed Polling Loop
// ============================================================================

export interface JulesSupervisorOptions {
  store: Store;
  sessionManager: JulesSessionManager;
  julesClient?: JulesApiClient;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
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
    if (this.isTickInProgress) {
      return { polled: 0, active: 0, errors: 0 };
    }

    this.isTickInProgress = true;
    let polled = 0;
    let errors = 0;

    const nonTerminalSessions = this.options.store.manager.cloudSessions.listNonTerminal();
    const leaseDuration = this.options.leaseDurationMs ?? 30_000;

    for (const session of nonTerminalSessions) {
      // 1. Acquire distributed lease
      const acquired = this.options.store.manager.cloudSessions.acquirePollingLease(session.id, leaseDuration);
      if (!acquired) continue;

      try {
        // 2. Poll remote session & stream activities
        const pollResult = await this.options.sessionManager.pollSession(session.remoteSessionId, {
          julesClient: this.options.julesClient,
        });
        polled += 1;

        // 3. Handle terminal transition callback
        if (pollResult.isTerminal) {
          const prOutput = pollResult.julesSession?.outputs?.pullRequest;
          await this.options.onTerminal?.({
            taskId: session.taskId,
            remoteSessionId: session.remoteSessionId,
            state: (pollResult.julesState as string) || 'COMPLETED',
            prUrl: prOutput?.url,
            prHeadSha: prOutput?.headCommitSha,
          });
        }
      } catch (err: unknown) {
        errors += 1;
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.onError?.(error, session);
      } finally {
        // 4. Release lease
        this.options.store.manager.cloudSessions.releasePollingLease(session.id);
      }
    }

    this.isTickInProgress = false;
    return {
      polled,
      active: nonTerminalSessions.length,
      errors,
    };
  }
}
