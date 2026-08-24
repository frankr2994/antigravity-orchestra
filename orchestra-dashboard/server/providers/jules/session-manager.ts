import type { Store } from '../../db.js';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import {
  type CloudSessionReference,
  type ExecutionAttempt,
  type OrchestraTaskState,
} from '../../domain/index.js';
import { mapJulesToOrchestraState, isJulesTerminalState, type JulesSessionState } from './state-mapper.js';
import { JulesApiClient } from './client.js';
import { resolveJulesApiKey } from './credentials.js';
import { runJulesPreflight } from './preflight.js';
import type { JulesActivity, JulesSession } from './types.js';
import { JulesApiError } from './errors.js';
import { translateJulesActivity } from './activity-translator.js';

// ============================================================================
// Google Jules Cloud Dispatch & Session Lifecycle Manager
// ============================================================================

export interface JulesDispatchOptions {
  projectRoot: string;
  title?: string;
  autoPr?: boolean;
  requirePlanApproval?: boolean;
  vault?: CredentialVault;
  julesClient?: JulesApiClient;
  onEvent?: (event: { name: string; payload: unknown }) => void;
}

export interface JulesDispatchResult {
  ok: boolean;
  cloudSession?: CloudSessionReference;
  attempt?: ExecutionAttempt;
  julesSession?: JulesSession;
  error?: string;
  preflightReason?: string;
  resolution?: string;
  ambiguous?: boolean;
}

export interface JulesDispatchIdentity {
  sourceName: string;
  dispatchBranch: string;
  targetBranch: string;
  baseSha: string;
}

export interface JulesPollResult {
  ok: boolean;
  remoteSessionId: string;
  julesState?: JulesSessionState | string;
  orchestraState?: OrchestraTaskState;
  isTerminal: boolean;
  julesSession?: JulesSession;
  activities: JulesActivity[];
  newActivitiesCount: number;
  error?: string;
}

export class JulesSessionManager {
  constructor(
    private readonly store: Store,
    private readonly vault?: CredentialVault
  ) {}

  private resolveClient(customClient?: JulesApiClient, vault?: CredentialVault): JulesApiClient {
    if (customClient) return customClient;
    const v = vault ?? this.vault ?? new CredentialVault();
    const { apiKey } = resolveJulesApiKey(v);
    if (!apiKey) {
      throw new Error('Cannot initialize Jules API Client: JULES_API_KEY is not configured in environment or vault.');
    }
    return new JulesApiClient({ apiKey, timeoutMs: 15_000 });
  }

  async dispatchSession(
    taskId: string,
    prompt: string,
    options: JulesDispatchOptions
  ): Promise<JulesDispatchResult> {
    const vault = options.vault ?? this.vault;

    // 1. Run preflight
    const preflight = await runJulesPreflight({
      taskId,
      projectRoot: options.projectRoot,
      vault,
      julesClient: options.julesClient,
      store: this.store,
      projectId: this.store.getTask(taskId)?.projectId,
    });

    if (!preflight.ok) {
      return {
        ok: false,
        error: preflight.reason || 'Jules preflight check failed.',
        preflightReason: preflight.reason,
        resolution: preflight.resolution,
      };
    }
    this.store.manager.checkpoints.append({ taskId, stage: 'preflight', subjectSha: preflight.baseSha,
      data: { status: 'verified', sourceName: preflight.sourceName!, dispatchBranch: preflight.dispatchBranch!,
        targetBranch: preflight.targetBranch!, baseSha: preflight.baseSha! } });

    // 2. Initialize API Client
    const client = this.resolveClient(options.julesClient, vault);

    // 3. Create Cloud Session on Google Jules API
    let julesSession: JulesSession;
    try {
      julesSession = await client.createSession({
        prompt,
        title: options.title || `Orchestra Task: ${taskId.slice(0, 8)}`,
        sourceContext: {
          source: preflight.sourceName!,
          githubRepoContext: {
            startingBranch: preflight.dispatchBranch!,
          },
        },
        requirePlanApproval: options.requirePlanApproval ?? false,
        automationMode: options.autoPr ? 'AUTO_CREATE_PR' : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Failed to create Jules session: ${message}`,
        ambiguous: !(err instanceof JulesApiError && err.status >= 400 && err.status < 500),
      };
    }

    // 4. Persist every local consequence of the provider acknowledgement atomically.
    const { attempt, cloudSession, remoteSessionId } = this.recordDispatchAcknowledgement(taskId, julesSession, {
      sourceName: preflight.sourceName!, dispatchBranch: preflight.dispatchBranch!,
      targetBranch: preflight.targetBranch!, baseSha: preflight.baseSha!,
    });

    options.onEvent?.({
      name: 'cloud.dispatched',
      payload: { taskId, remoteSessionId, dispatchBranch: preflight.dispatchBranch },
    });

    return {
      ok: true,
      cloudSession,
      attempt,
      julesSession,
    };
  }

  async pollSession(
    remoteSessionId: string,
    options?: {
      julesClient?: JulesApiClient;
      onActivity?: (activity: JulesActivity) => void;
      lease?: { ownerId: string; fencingToken: number };
    }
  ): Promise<JulesPollResult> {
    const cloudSession = this.store.manager.cloudSessions.getByRemoteSessionId(remoteSessionId);
    if (!cloudSession) {
      return {
        ok: false,
        remoteSessionId,
        isTerminal: false,
        activities: [],
        newActivitiesCount: 0,
        error: `No local cloud session tracked for remote ID '${remoteSessionId}'.`,
      };
    }

    let client: JulesApiClient;
    try {
      client = this.resolveClient(options?.julesClient);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        remoteSessionId,
        isTerminal: false,
        activities: [],
        newActivitiesCount: 0,
        error: message,
      };
    }

    let session: JulesSession;
    const activities: JulesActivity[] = [];
    const cursor = this.store.manager.activityCursors.ensure(cloudSession.id);

    try {
      session = await client.getSession(remoteSessionId);
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      for (let page = 0; page < 100; page += 1) {
        const response = await client.listActivities(remoteSessionId, 100, pageToken, undefined, cursor.lastActivityAt ?? undefined);
        activities.push(...response.activities);
        if (!response.nextPageToken) break;
        if (seenTokens.has(response.nextPageToken)) throw new Error('Jules activity pagination repeated a page token');
        seenTokens.add(response.nextPageToken);
        pageToken = response.nextPageToken;
        if (page === 99) throw new Error('Jules activity pagination exceeded the safety limit');
      }
    } catch {
      const failures = cursor.consecutiveFailures + 1;
      const delay = Math.min(300_000, 5_000 * (2 ** Math.min(failures, 6)));
      try {
        if (options?.lease) this.store.manager.leases.assertFence('jules_poll', cloudSession.id, options.lease.ownerId, options.lease.fencingToken);
        this.store.manager.activityCursors.compareAndSet(cloudSession.id, cursor.version, {
          nextPollAt: new Date(Date.now() + delay).toISOString(), consecutiveFailures: failures,
          lastActivityId: cursor.lastActivityId, lastActivityAt: cursor.lastActivityAt, lastErrorCode: 'JULES_POLL_FAILED',
        });
      } catch { /* A newer poll owner controls the cursor. */ }
      return {
        ok: false,
        remoteSessionId,
        isTerminal: false,
        activities: [],
        newActivitiesCount: 0,
        error: 'Jules polling failed; the durable cursor was retained for retry.',
      };
    }

    const julesState = session.state;
    const mapping = mapJulesToOrchestraState(julesState);
    const isTerminal = isJulesTerminalState(julesState);

    // Persist activity identities and state as one fenced unit of work.
    let newActivitiesCount = 0;
    const newActivities: JulesActivity[] = [];
    const prOutput = Array.isArray(session.outputs) ? session.outputs.find((o) => o.pullRequest?.url)?.pullRequest : undefined;
    const prUrl = prOutput?.url || cloudSession.prUrl;
    const ordered = [...activities].sort((left, right) => (left.createTime ?? '').localeCompare(right.createTime ?? '') || left.name.localeCompare(right.name));
    const newest = ordered.at(-1);
    this.store.manager.transaction(() => {
      if (options?.lease) this.store.manager.leases.assertFence('jules_poll', cloudSession.id, options.lease.ownerId, options.lease.fencingToken);
      for (const activity of ordered) {
        const activityId = activity.id || activity.name;
        if (this.store.manager.julesActivityReceipts.record(cloudSession.id, activityId, activity.createTime)) {
          newActivitiesCount += 1;
          newActivities.push(activity);
          this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.activity', translateJulesActivity(activity));
        }
      }
      if (julesState !== cloudSession.state) {
        this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.activity', {
          kind: 'state',
          title: `Jules is ${String(julesState).replaceAll('_', ' ').toLowerCase()}`,
          description: mapping.reason ?? `Provider state changed from ${cloudSession.state} to ${julesState}.`,
          state: julesState,
          requiresUserAction: mapping.requiresUserAction,
        });
      }
      this.store.manager.cloudSessions.update(cloudSession.id, {
        state: julesState, prUrl, lastActivityId: newest?.id || newest?.name || cloudSession.lastActivityId,
        lastActivityAt: newest?.createTime || cloudSession.lastActivityAt,
      });
      if (julesState === 'COMPLETED' && cloudSession.state !== 'COMPLETED') {
        this.store.updateTask(cloudSession.taskId, { state: mapping.taskState });
        this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.completed', { remoteSessionId, prUrl });
        this.store.manager.evidence.record({ taskId: cloudSession.taskId, attemptId: cloudSession.attemptId,
          kind: 'provider_output', outcome: 'completed', payload: { remoteSessionId, prUrl: prUrl ?? null, state: julesState } });
      } else if (julesState === 'FAILED' && cloudSession.state !== 'FAILED') {
        this.store.updateTask(cloudSession.taskId, { state: 'failed' });
        this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.failed', { remoteSessionId });
        this.store.manager.julesCapacity.release(cloudSession.taskId);
      }
      this.store.manager.activityCursors.compareAndSet(cloudSession.id, cursor.version, {
        nextPollAt: isTerminal ? '9999-12-31T23:59:59.999Z' : new Date(Date.now() + 5_000).toISOString(),
        consecutiveFailures: 0, lastErrorCode: null,
        lastActivityId: newest?.id || newest?.name || cursor.lastActivityId,
        lastActivityAt: newest?.createTime || cursor.lastActivityAt,
      });
    });
    for (const activity of newActivities) options?.onActivity?.(activity);

    return {
      ok: true,
      remoteSessionId,
      julesState,
      orchestraState: mapping.taskState,
      isTerminal,
      julesSession: session,
      activities,
      newActivitiesCount,
    };
  }

  recordDispatchAcknowledgement(taskId: string, julesSession: JulesSession, identity: JulesDispatchIdentity): {
    attempt: ExecutionAttempt;
    cloudSession: CloudSessionReference;
    remoteSessionId: string;
  } {
    const existing = this.store.manager.cloudSessions.getByTaskId(taskId);
    if (existing) {
      const attempt = existing.attemptId ? this.store.manager.attempts.getById(existing.attemptId) : null;
      if (!attempt) throw new Error(`Cloud session for task ${taskId} has no recoverable execution attempt`);
      return { attempt, cloudSession: existing, remoteSessionId: existing.remoteSessionId };
    }
    const remoteSessionId = julesSession.id || julesSession.name.split('/').pop()!;
    let attempt!: ExecutionAttempt;
    let cloudSession!: CloudSessionReference;
    this.store.manager.transaction(() => {
      attempt = this.store.manager.attempts.create({
        taskId, target: 'cloud', worker: 'jules', baseSha: identity.baseSha,
        branchName: identity.dispatchBranch, state: 'WORKING', providerSessionId: remoteSessionId,
      });
      cloudSession = this.store.manager.cloudSessions.create({
        taskId, attemptId: attempt.id, sourceName: identity.sourceName, sessionResourceName: julesSession.name,
        remoteSessionId, dispatchBranch: identity.dispatchBranch, targetBranch: identity.targetBranch,
        baseSha: identity.baseSha, state: julesSession.state || 'QUEUED',
      });
      this.store.manager.activityCursors.ensure(cloudSession.id);
      this.store.addEvent(taskId, 'jules', 'cloud.dispatched', {
        remoteSessionId, sessionName: julesSession.name, dispatchBranch: identity.dispatchBranch,
        targetBranch: identity.targetBranch, baseSha: identity.baseSha, state: julesSession.state,
      });
      this.store.manager.checkpoints.append({ taskId, attemptId: attempt.id, stage: 'dispatch', subjectSha: identity.baseSha,
        data: { status: 'provider_acknowledged', remoteSessionId, dispatchBranch: identity.dispatchBranch } });
      if (this.store.getTask(taskId)?.state === 'failed') {
        this.store.updateTask(taskId, { state: 'queued', error: null });
      }
      this.store.updateTask(taskId, { state: 'running', error: null });
    });
    return { attempt, cloudSession, remoteSessionId };
  }

  async cancelSession(
    remoteSessionId: string,
    options?: { julesClient?: JulesApiClient }
  ): Promise<{ ok: boolean; code?: 'CLOUD_SESSION_NOT_FOUND' | 'JULES_CANCELLATION_FAILED'; error?: string }> {
    const cloudSession = this.store.manager.cloudSessions.getByRemoteSessionId(remoteSessionId);
    if (!cloudSession) {
      return {
        ok: false,
        code: 'CLOUD_SESSION_NOT_FOUND',
        error: `Cloud session '${remoteSessionId}' was not found.`,
      };
    }
    let client = options?.julesClient;
    if (!client) {
      const { apiKey } = resolveJulesApiKey();
      if (!apiKey) return { ok: false, code: 'JULES_CANCELLATION_FAILED', error: 'A Jules API key is required to delete the remote session.' };
      client = new JulesApiClient({ apiKey });
    }
    try {
      await client.deleteSession(cloudSession.sessionResourceName);
    } catch (error) {
      if (!(error instanceof JulesApiError && error.status === 404)) {
        return { ok: false, code: 'JULES_CANCELLATION_FAILED', error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.store.manager.transaction(() => {
      this.store.manager.cloudSessions.update(cloudSession.id, { state: 'CANCELLED' });
      for (const attempt of this.store.manager.attempts.listByTaskId(cloudSession.taskId)) {
        if (attempt.state === 'WORKING') this.store.manager.attempts.update(attempt.id, { state: 'CANCELLED', completedAt: new Date().toISOString() });
      }
      const task = this.store.getTask(cloudSession.taskId);
      if (task && !['completed', 'completed_unpushed', 'failed', 'cancelled'].includes(task.state)) {
        this.store.updateTask(task.id, { state: 'cancelled', error: 'The Jules cloud session was deleted at the user\'s request.' });
      }
      this.store.manager.julesCapacity.release(cloudSession.taskId);
      this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.cancelled', { remoteSessionId });
    });
    return { ok: true };
  }
}
