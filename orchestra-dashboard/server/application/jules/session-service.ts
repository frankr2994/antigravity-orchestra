import type { Store } from '../../db.js';
import type { JulesApiClient } from '../../providers/jules/client.js';
import { JulesSessionManager } from '../../providers/jules/session-manager.js';
import type { CredentialVault } from '../../infrastructure/security/vault.js';
import { CommandIntentRepository } from '../../infrastructure/database/repositories/intents.js';
import { ApplicationError } from '../errors.js';
import type { JulesDispatchCommand } from './requests.js';
import { createHash } from 'node:crypto';
import { JulesApiError } from '../../providers/jules/errors.js';
import { config } from '../../config.js';
import type { CommandIntent } from '../../domain/index.js';
import type { JulesSession } from '../../providers/jules/types.js';

export class JulesSessionService {
  constructor(
    private readonly store: Store,
    private readonly vault: CredentialVault,
    private readonly manager: JulesSessionManager,
    private readonly client: () => JulesApiClient,
    private readonly injectedClient?: JulesApiClient,
  ) {}

  async dispatch(projectId: string, command: JulesDispatchCommand) {
    const project = this.store.getProject(projectId);
    if (!project) throw new ApplicationError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    if (command.sessionId) {
      const session = this.store.manager.sessions.getById(command.sessionId);
      if (!session || session.projectId !== project.id) {
        throw new ApplicationError('SESSION_PROJECT_MISMATCH', 'Session does not belong to the selected project.', 409);
      }
    }
    const requestHash = CommandIntentRepository.requestHash({ projectId, ...command });
    const existing = this.store.manager.commandIntents.getByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (existing.kind !== 'jules.dispatch' || existing.requestHash !== requestHash) {
        throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused for a different dispatch.', 409);
      }
      if (existing.state === 'acknowledged' && existing.response) return existing.response;
      const recovered = this.store.manager.cloudSessions.getByTaskId(existing.taskId);
      if (recovered && (existing.state === 'pending' || existing.state === 'ambiguous')) {
        const recoveredTask = this.store.getTask(existing.taskId);
        if (!recoveredTask) throw new ApplicationError('DISPATCH_RECONCILIATION_REQUIRED', 'The dispatch task could not be recovered.', 409);
        const response = { ok: true, taskId: existing.taskId, sessionId: recoveredTask.sessionId,
          remoteSessionId: recovered.remoteSessionId, cloudSession: recovered };
        this.store.manager.transaction(() => {
          this.store.manager.commandIntents.transition(existing.id, existing.state, 'acknowledged', {
            attemptId: recovered.attemptId, providerResource: recovered.sessionResourceName, response,
          });
          this.store.manager.checkpoints.append({ taskId: existing.taskId, attemptId: recovered.attemptId,
            stage: 'dispatch', subjectSha: recovered.baseSha, data: { status: 'locally_reconciled', remoteSessionId: recovered.remoteSessionId } });
        });
        return response;
      }
      if (existing.state === 'pending' || existing.state === 'ambiguous') {
        const reconciled = await this.reconcileDispatch(existing, command.prompt);
        if (reconciled) return reconciled;
      }
      throw new ApplicationError('DISPATCH_RECONCILIATION_REQUIRED', 'This dispatch is pending reconciliation.', 409);
    }

    let taskId = ''; let sessionId = command.sessionId ?? '';
    this.store.manager.transaction(() => {
      if (!sessionId) sessionId = this.store.createSession(project.id, command.prompt.slice(0, 40)).id;
      const task = this.store.createTask(project.id, sessionId!, command.prompt, null, null, 'cloud');
      taskId = task.id;
      this.store.addMessage({ sessionId, taskId, role: 'user', agent: 'system', content: command.prompt });
      this.store.manager.commandIntents.createOrGet({
        taskId, kind: 'jules.dispatch', idempotencyKey: command.idempotencyKey, requestHash,
      });
      if (!this.store.manager.julesCapacity.reserve(taskId, config.jules.maxConcurrentSessions)) {
        throw new ApplicationError('JULES_CAPACITY_REACHED', 'The configured concurrent Jules session capacity is currently in use.', 429);
      }
      this.store.manager.checkpoints.append({ taskId, stage: 'dispatch', data: { status: 'intent_recorded' } });
    });

    try {
      const result = await this.manager.dispatchSession(taskId, command.prompt, {
        projectRoot: project.root, requirePlanApproval: command.requirePlanApproval, autoPr: command.autoPr,
        vault: this.vault, julesClient: this.injectedClient,
      });
      const intent = this.store.manager.commandIntents.getByIdempotencyKey(command.idempotencyKey)!;
      if (!result.ok) {
        if (result.ambiguous) {
          this.store.manager.commandIntents.transition(intent.id, 'pending', 'ambiguous', { errorCode: 'JULES_DISPATCH_AMBIGUOUS' });
          const reconciled = await this.reconcileDispatch(
            this.store.manager.commandIntents.getById(intent.id)!, command.prompt,
          );
          if (reconciled) return reconciled;
          throw new ApplicationError('JULES_DISPATCH_AMBIGUOUS', 'Jules may have accepted the dispatch. Orchestra will keep reconciling it automatically; do not submit a duplicate.', 503);
        }
        this.store.manager.commandIntents.transition(intent.id, 'pending', 'failed', { errorCode: 'JULES_DISPATCH_REJECTED' });
        this.store.manager.julesCapacity.release(taskId);
        throw new ApplicationError('JULES_DISPATCH_REJECTED', result.error ?? 'Jules dispatch was rejected.', 400);
      }
      const response = {
        ok: true, taskId, sessionId, remoteSessionId: result.cloudSession?.remoteSessionId,
        cloudSession: result.cloudSession ?? null,
      };
      this.store.manager.transaction(() => {
        this.store.manager.commandIntents.transition(intent.id, 'pending', 'acknowledged', {
          attemptId: result.attempt?.id ?? null, providerResource: result.cloudSession?.sessionResourceName ?? null, response,
        });
        this.store.manager.checkpoints.append({ taskId, attemptId: result.cloudSession?.attemptId,
          stage: 'dispatch', data: { status: 'acknowledged' } });
      });
      return response;
    } catch (error) {
      const intent = this.store.manager.commandIntents.getByIdempotencyKey(command.idempotencyKey);
      if (intent?.state === 'pending') this.store.manager.commandIntents.transition(intent.id, 'pending', 'ambiguous', { errorCode: 'JULES_DISPATCH_AMBIGUOUS' });
      if (intent?.state === 'failed') this.store.manager.julesCapacity.release(taskId);
      throw error;
    }
  }

  async reconcilePendingDispatches(): Promise<number> {
    let count = 0;
    for (const intent of this.store.manager.commandIntents.listPending()) {
      if (intent.kind !== 'jules.dispatch') continue;
      const task = this.store.getTask(intent.taskId);
      if (!task || ['cancelled', 'completed', 'completed_unpushed'].includes(task.state)) continue;
      if (await this.reconcileDispatch(intent, task.prompt)) count += 1;
    }
    return count;
  }

  getTaskSession(taskId: string) {
    const task = this.requireTask(taskId);
    return { task, cloudSession: this.store.manager.cloudSessions.getByTaskId(task.id) };
  }
  async approvePlan(taskId: string, idempotencyKey: string) {
    const cloud = this.requireCloudSession(taskId);
    return this.executeInteraction(taskId, cloud.sessionResourceName, 'jules.approve-plan', idempotencyKey, {}, async () => {
      const remote = await this.client().getSession(cloud.sessionResourceName);
      if (remote.state !== 'AWAITING_PLAN_APPROVAL') throw new ApplicationError('JULES_STATE_CONFLICT', 'Jules is not awaiting plan approval.', 409);
      await this.client().approvePlan(cloud.sessionResourceName);
    }, 'cloud.plan_approved', { remoteSessionId: cloud.remoteSessionId });
  }
  async sendMessage(taskId: string, prompt: string, idempotencyKey: string) {
    const cloud = this.requireCloudSession(taskId);
    const promptHash = createHash('sha256').update(prompt).digest('hex');
    return this.executeInteraction(taskId, cloud.sessionResourceName, 'jules.message', idempotencyKey, { promptHash }, async () => {
      const remote = await this.client().getSession(cloud.sessionResourceName);
      if (!['AWAITING_USER_FEEDBACK', 'PAUSED'].includes(remote.state)) throw new ApplicationError('JULES_STATE_CONFLICT', 'Jules is not accepting interactive feedback in its current state.', 409);
      await this.client().sendMessage(cloud.sessionResourceName, prompt);
    }, 'cloud.feedback_sent', { remoteSessionId: cloud.remoteSessionId, promptHash, promptLength: prompt.length });
  }
  async listActivities(taskId: string, pageSize?: number, pageToken?: string) {
    const cloud = this.requireCloudSession(taskId);
    return this.client().listActivities(cloud.sessionResourceName, pageSize, pageToken);
  }
  private requireTask(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!task) throw new ApplicationError('TASK_NOT_FOUND', 'Task not found.', 404);
    return task;
  }
  private async reconcileDispatch(intent: CommandIntent, prompt: string): Promise<Record<string, unknown> | null> {
    const task = this.store.getTask(intent.taskId);
    const checkpoint = this.store.manager.checkpoints.latest(intent.taskId, 'preflight');
    if (!task || !checkpoint) return null;
    const sourceName = typeof checkpoint.data.sourceName === 'string' ? checkpoint.data.sourceName : null;
    const dispatchBranch = typeof checkpoint.data.dispatchBranch === 'string' ? checkpoint.data.dispatchBranch : null;
    const targetBranch = typeof checkpoint.data.targetBranch === 'string' ? checkpoint.data.targetBranch : null;
    const baseSha = typeof checkpoint.data.baseSha === 'string' ? checkpoint.data.baseSha : checkpoint.subjectSha;
    if (!sourceName || !dispatchBranch || !targetBranch || !baseSha) return null;

    const title = `Orchestra Task: ${intent.taskId.slice(0, 8)}`;
    const matches = new Map<string, JulesSession>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < 100; page += 1) {
        const response = await this.client().listSessions(100, pageToken);
        for (const session of response.sessions) {
          if (session.title !== title) continue;
          if (session.sourceContext?.source !== sourceName) continue;
          if (session.sourceContext.githubRepoContext?.startingBranch !== dispatchBranch) continue;
          if (session.prompt !== undefined && session.prompt !== prompt) continue;
          matches.set(session.name, session);
        }
        if (!response.nextPageToken) break;
        if (seenTokens.has(response.nextPageToken)) return null;
        seenTokens.add(response.nextPageToken);
        pageToken = response.nextPageToken;
        if (page === 99) return null;
      }
    } catch {
      return null;
    }
    if (matches.size !== 1) return null;
    const session = [...matches.values()][0]!;
    const adopted = this.manager.recordDispatchAcknowledgement(intent.taskId, session, {
      sourceName, dispatchBranch, targetBranch, baseSha,
    });
    const response = { ok: true, taskId: intent.taskId, sessionId: task.sessionId,
      remoteSessionId: adopted.remoteSessionId, cloudSession: adopted.cloudSession };
    this.store.manager.transaction(() => {
      this.store.manager.commandIntents.transition(intent.id, intent.state, 'acknowledged', {
        attemptId: adopted.attempt.id, providerResource: adopted.cloudSession.sessionResourceName, response,
      });
      this.store.manager.checkpoints.append({ taskId: intent.taskId, attemptId: adopted.attempt.id,
        stage: 'dispatch', subjectSha: baseSha, data: { status: 'provider_reconciled', remoteSessionId: adopted.remoteSessionId } });
    });
    return response;
  }
  private requireCloudSession(taskId: string) {
    const task = this.requireTask(taskId);
    const cloud = this.store.manager.cloudSessions.getByTaskId(task.id);
    if (!cloud) throw new ApplicationError('CLOUD_SESSION_NOT_FOUND', 'Cloud session not found for task.', 404);
    return cloud;
  }
  private async executeInteraction(
    taskId: string, providerResource: string, kind: string, idempotencyKey: string,
    request: Record<string, unknown>, mutation: () => Promise<void>, eventType: 'cloud.plan_approved' | 'cloud.feedback_sent',
    eventPayload: Record<string, unknown>,
  ) {
    const requestHash = CommandIntentRepository.requestHash({ taskId, kind, ...request });
    const found = this.store.manager.commandIntents.getByIdempotencyKey(idempotencyKey);
    if (found) {
      if (found.taskId !== taskId || found.kind !== kind || found.requestHash !== requestHash) throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused for another action.', 409);
      if (found.state === 'acknowledged' && found.response) return found.response;
      throw new ApplicationError('ACTION_RECONCILIATION_REQUIRED', 'This action is pending reconciliation.', 409);
    }
    const { intent } = this.store.manager.commandIntents.createOrGet({ taskId, kind, idempotencyKey, requestHash });
    try {
      await mutation();
      const response = { ok: true };
      this.store.manager.transaction(() => {
        this.store.manager.commandIntents.transition(intent.id, 'pending', 'acknowledged', { providerResource, response });
        this.store.addEvent(taskId, 'orchestra', eventType, eventPayload);
      });
      return response;
    } catch (error) {
      if (error instanceof ApplicationError) {
        this.store.manager.commandIntents.transition(intent.id, 'pending', 'failed', { errorCode: error.code });
        throw error;
      }
      const definite = error instanceof JulesApiError && error.status >= 400 && error.status < 500;
      this.store.manager.commandIntents.transition(intent.id, 'pending', definite ? 'failed' : 'ambiguous', {
        errorCode: definite ? 'JULES_ACTION_REJECTED' : 'JULES_ACTION_AMBIGUOUS',
      });
      throw new ApplicationError(definite ? 'JULES_ACTION_REJECTED' : 'JULES_ACTION_AMBIGUOUS',
        definite ? 'Jules rejected the requested action.' : 'Jules may have accepted the action; reconciliation is required.', definite ? 409 : 503);
    }
  }
}
