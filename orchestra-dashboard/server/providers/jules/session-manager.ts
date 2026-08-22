import type { Store } from '../../db.js';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import type { CloudSessionReference, ExecutionAttempt, OrchestraTaskState } from '../../domain/index.js';
import { mapJulesToOrchestraState, isJulesTerminalState, type JulesSessionState } from '../../domain/tasks/states.js';
import { JulesApiClient } from './client.js';
import { resolveJulesApiKey } from './credentials.js';
import { runJulesPreflight } from './preflight.js';
import type { JulesActivity, JulesSession } from './types.js';

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
  skipPush?: boolean;
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
      skipPush: options.skipPush,
    });

    if (!preflight.ok) {
      return {
        ok: false,
        error: preflight.reason || 'Jules preflight check failed.',
        preflightReason: preflight.reason,
        resolution: preflight.resolution,
      };
    }

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
        autoPr: options.autoPr ?? false,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Failed to create Jules session: ${message}`,
      };
    }

    const remoteSessionId = julesSession.id || julesSession.name.split('/').pop()!;

    // 4. Record execution attempt in SQLite
    const attempt = this.store.manager.attempts.create({
      taskId,
      target: 'cloud',
      worker: 'jules',
      baseSha: preflight.baseSha!,
      branchName: preflight.dispatchBranch,
      state: 'WORKING',
      providerSessionId: remoteSessionId,
    });

    // 5. Record cloud session reference in SQLite
    const cloudSession = this.store.manager.cloudSessions.create({
      taskId,
      sourceName: preflight.sourceName!,
      sessionResourceName: julesSession.name,
      remoteSessionId,
      dispatchBranch: preflight.dispatchBranch!,
      targetBranch: preflight.targetBranch!,
      baseSha: preflight.baseSha!,
      state: julesSession.state || 'QUEUED',
    });

    // 6. Record task event and update task status
    this.store.addEvent(taskId, 'jules', 'cloud.dispatched', {
      remoteSessionId,
      sessionName: julesSession.name,
      dispatchBranch: preflight.dispatchBranch,
      targetBranch: preflight.targetBranch,
      state: julesSession.state,
    });

    options.onEvent?.({
      name: 'cloud.dispatched',
      payload: { taskId, remoteSessionId, dispatchBranch: preflight.dispatchBranch },
    });

    this.store.updateTask(taskId, { state: 'running' });

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
    let activities: JulesActivity[] = [];

    try {
      [session, activities] = await Promise.all([
        client.getSession(remoteSessionId),
        client.listActivities(remoteSessionId).catch(() => []),
      ]);
    } catch (err: unknown) {
      // Network dropout / transient error: preserve state without crashing task
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        remoteSessionId,
        isTerminal: false,
        activities: [],
        newActivitiesCount: 0,
        error: `Transient poll failure: ${message}`,
      };
    }

    const julesState = session.state;
    const mapping = mapJulesToOrchestraState(julesState);
    const isTerminal = isJulesTerminalState(julesState);

    // Filter new activities
    let newActivitiesCount = 0;
    const latestExistingStamp = cloudSession.lastActivityAt ? new Date(cloudSession.lastActivityAt).getTime() : 0;

    for (const activity of activities) {
      const activityStamp = activity.createTime ? new Date(activity.createTime).getTime() : 0;
      if (activityStamp > latestExistingStamp || (!cloudSession.lastActivityId && activity.id)) {
        newActivitiesCount += 1;
        this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.activity', activity);
        options?.onActivity?.(activity);
      }
    }

    // Extract PR output details if present
    const prUrl = session.outputs?.pullRequest?.url || cloudSession.prUrl;
    const prHeadSha = session.outputs?.pullRequest?.headCommitSha || cloudSession.prHeadSha;
    const latestActivity = activities.at(-1);

    // Update cloud session in SQLite
    this.store.manager.cloudSessions.update(cloudSession.id, {
      state: julesState,
      prUrl,
      prHeadSha,
      lastActivityId: latestActivity?.id || cloudSession.lastActivityId,
      lastActivityAt: latestActivity?.createTime || cloudSession.lastActivityAt,
    });

    // Handle terminal transitions
    if (julesState === 'COMPLETED') {
      this.store.updateTask(cloudSession.taskId, { state: 'completed' });
      this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.completed', {
        remoteSessionId,
        prUrl,
        prHeadSha,
      });
    } else if (julesState === 'FAILED') {
      this.store.updateTask(cloudSession.taskId, { state: 'failed' });
      this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.failed', {
        remoteSessionId,
      });
    }

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

  async cancelSession(
    remoteSessionId: string,
    options?: { julesClient?: JulesApiClient }
  ): Promise<{ ok: boolean; error?: string }> {
    const cloudSession = this.store.manager.cloudSessions.getByRemoteSessionId(remoteSessionId);
    if (!cloudSession) {
      return { ok: false, error: `Cloud session '${remoteSessionId}' not found.` };
    }

    try {
      const client = this.resolveClient(options?.julesClient);
      await client.pause(remoteSessionId).catch(() => null);
    } catch {
      // Best-effort remote cancel
    }

    this.store.manager.cloudSessions.update(cloudSession.id, {
      state: 'CANCELLED',
    });

    this.store.updateTask(cloudSession.taskId, { state: 'failed' });
    this.store.addEvent(cloudSession.taskId, 'jules', 'cloud.cancelled', {
      remoteSessionId,
    });

    return { ok: true };
  }
}
