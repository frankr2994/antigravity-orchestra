import type { Store } from '../../db.js';
import type { JulesApiClient } from '../../providers/jules/client.js';
import { JulesSessionManager } from '../../providers/jules/session-manager.js';
import type { CredentialVault } from '../../infrastructure/security/vault.js';
import { CommandIntentRepository } from '../../infrastructure/database/repositories/intents.js';
import { ApplicationError } from '../errors.js';
import type { JulesDispatchCommand } from './requests.js';

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
      throw new ApplicationError('DISPATCH_RECONCILIATION_REQUIRED', 'This dispatch is pending reconciliation.', 409);
    }

    let taskId = ''; let sessionId = command.sessionId ?? '';
    this.store.manager.transaction(() => {
      if (!sessionId) sessionId = this.store.createSession(project.id, command.prompt.slice(0, 40)).id;
      const task = this.store.createTask(project.id, sessionId!, command.prompt, null, null, 'cloud');
      taskId = task.id;
      this.store.manager.commandIntents.createOrGet({
        taskId, kind: 'jules.dispatch', idempotencyKey: command.idempotencyKey, requestHash,
      });
      this.store.manager.checkpoints.append({ taskId, stage: 'dispatch', data: { status: 'intent_recorded' } });
    });

    try {
      const result = await this.manager.dispatchSession(taskId, command.prompt, {
        projectRoot: project.root, requirePlanApproval: command.requirePlanApproval, autoPr: command.autoPr,
        vault: this.vault, julesClient: this.injectedClient,
      });
      const intent = this.store.manager.commandIntents.getByIdempotencyKey(command.idempotencyKey)!;
      if (!result.ok) {
        this.store.manager.commandIntents.transition(intent.id, 'pending', 'failed', { errorCode: 'JULES_DISPATCH_REJECTED' });
        throw new ApplicationError('JULES_DISPATCH_REJECTED', result.error ?? 'Jules dispatch was rejected.', 400);
      }
      const response = {
        ok: true, taskId, sessionId, remoteSessionId: result.cloudSession?.remoteSessionId,
        cloudSession: result.cloudSession ?? null,
      };
      this.store.manager.transaction(() => {
        this.store.manager.commandIntents.transition(intent.id, 'pending', 'acknowledged', {
          providerResource: result.cloudSession?.sessionResourceName ?? null, response,
        });
        this.store.manager.checkpoints.append({ taskId, attemptId: result.cloudSession?.attemptId,
          stage: 'dispatch', data: { status: 'acknowledged' } });
      });
      return response;
    } catch (error) {
      const intent = this.store.manager.commandIntents.getByIdempotencyKey(command.idempotencyKey);
      if (intent?.state === 'pending') this.store.manager.commandIntents.transition(intent.id, 'pending', 'ambiguous', { errorCode: 'JULES_DISPATCH_AMBIGUOUS' });
      throw error;
    }
  }

  getTaskSession(taskId: string) {
    const task = this.requireTask(taskId);
    return { task, cloudSession: this.store.manager.cloudSessions.getByTaskId(task.id) };
  }
  async approvePlan(taskId: string) {
    const cloud = this.requireCloudSession(taskId);
    await this.client().approvePlan(cloud.sessionResourceName);
    this.store.addEvent(taskId, 'orchestra', 'cloud.plan_approved', { remoteSessionId: cloud.remoteSessionId });
    return { ok: true };
  }
  async sendMessage(taskId: string, prompt: string) {
    const cloud = this.requireCloudSession(taskId);
    await this.client().sendMessage(cloud.sessionResourceName, prompt);
    this.store.addEvent(taskId, 'orchestra', 'cloud.feedback_sent', { remoteSessionId: cloud.remoteSessionId, prompt });
    return { ok: true };
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
  private requireCloudSession(taskId: string) {
    const task = this.requireTask(taskId);
    const cloud = this.store.manager.cloudSessions.getByTaskId(task.id);
    if (!cloud) throw new ApplicationError('CLOUD_SESSION_NOT_FOUND', 'Cloud session not found for task.', 404);
    return cloud;
  }
}
