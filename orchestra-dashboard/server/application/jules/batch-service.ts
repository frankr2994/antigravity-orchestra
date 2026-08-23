import type { Store } from '../../db.js';
import { config } from '../../config.js';
import { CommandIntentRepository } from '../../infrastructure/database/repositories/intents.js';
import type { JulesBatchCommand } from './requests.js';
import type { JulesSessionService } from './session-service.js';
import { ApplicationError } from '../errors.js';

export class JulesBatchService {
  constructor(private readonly store: Store, private readonly sessions: JulesSessionService) {}
  get(batchId: string) { return this.store.manager.cloudWorkflows.get(batchId); }

  async createAndLaunch(projectId: string, command: JulesBatchCommand) {
    if (!this.store.getProject(projectId)) throw new ApplicationError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    const maxConcurrency = Math.min(command.maxConcurrency ?? config.jules.maxConcurrentSessions, config.jules.maxConcurrentSessions);
    const requestHash = CommandIntentRepository.requestHash({ projectId, maxConcurrency, items: command.items });
    const found = this.store.manager.cloudWorkflows.getByKey(command.idempotencyKey);
    if (found) {
      if (found.projectId !== projectId || found.requestHash !== requestHash) throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused for another workflow.', 409);
      return found;
    }
    const batch = this.store.manager.transaction(() => this.store.manager.cloudWorkflows.create({
      projectId, idempotencyKey: command.idempotencyKey, requestHash, maxConcurrency,
      nodes: command.items.map((item) => ({ prompt: item.prompt, dependencies: item.dependsOn })),
    }));
    await this.launchReady(batch.id);
    return this.store.manager.cloudWorkflows.get(batch.id)!;
  }

  async reconcileTask(taskId: string): Promise<void> {
    const node = this.store.manager.cloudWorkflows.getByTask(taskId);
    if (!node) { for (const batch of this.store.manager.cloudWorkflows.listRunning()) await this.launchReady(batch.id); return; }
    const task = this.store.getTask(taskId); if (!task) return;
    if (task.state === 'completed') this.store.manager.cloudWorkflows.transitionNode(node.id, 'running', 'completed');
    else if (['failed', 'cancelled', 'review_disputed'].includes(task.state)) this.store.manager.cloudWorkflows.transitionNode(node.id, 'running', 'failed', { errorCode: 'DEPENDENCY_TASK_FAILED' });
    await this.launchReady(node.batchId);
  }

  async launchReady(batchId: string): Promise<void> {
    const batch = this.store.manager.cloudWorkflows.get(batchId); if (!batch || batch.state !== 'running') return;
    const byOrdinal = new Map(batch.nodes.map((node) => [node.ordinal, node]));
    for (const node of batch.nodes.filter((item) => item.state === 'queued')) {
      if (node.dependencies.some((dependency) => ['failed', 'blocked'].includes(byOrdinal.get(dependency)?.state ?? 'blocked'))) {
        this.store.manager.cloudWorkflows.transitionNode(node.id, 'queued', 'blocked', { errorCode: 'DEPENDENCY_FAILED' });
      }
    }
    const refreshed = this.store.manager.cloudWorkflows.get(batchId)!;
    const refreshedByOrdinal = new Map(refreshed.nodes.map((node) => [node.ordinal, node]));
    const active = refreshed.nodes.filter((node) => ['dispatching', 'running'].includes(node.state)).length;
    const available = Math.max(0, refreshed.maxConcurrency - active);
    const ready = refreshed.nodes.filter((node) => node.state === 'queued' && node.dependencies.every((dependency) => refreshedByOrdinal.get(dependency)?.state === 'completed')).slice(0, available);
    await Promise.all(ready.map(async (node) => {
      if (!this.store.manager.cloudWorkflows.transitionNode(node.id, 'queued', 'dispatching')) return;
      try {
        const result = await this.sessions.dispatch(refreshed.projectId, {
          prompt: node.prompt, requirePlanApproval: true, autoPr: true,
          idempotencyKey: `batch:${refreshed.id}:node:${node.ordinal}`,
        });
        this.store.manager.cloudWorkflows.transitionNode(node.id, 'dispatching', 'running', { taskId: String(result.taskId) });
      } catch (error) {
        if (error instanceof ApplicationError && error.code === 'JULES_CAPACITY_REACHED') {
          this.store.manager.cloudWorkflows.transitionNode(node.id, 'dispatching', 'queued', { errorCode: 'CAPACITY_WAIT' });
        } else {
          this.store.manager.cloudWorkflows.transitionNode(node.id, 'dispatching', 'failed', { errorCode: 'DISPATCH_FAILED' });
        }
      }
    }));
    const final = this.store.manager.cloudWorkflows.get(batchId)!;
    if (final.nodes.every((node) => node.state === 'completed')) this.store.manager.cloudWorkflows.updateBatch(batchId, 'completed');
    else if (final.nodes.every((node) => ['completed', 'failed', 'blocked'].includes(node.state)) && final.nodes.some((node) => node.state !== 'completed')) this.store.manager.cloudWorkflows.updateBatch(batchId, 'failed');
  }
}
