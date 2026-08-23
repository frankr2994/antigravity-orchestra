import type { Store } from '../../db.js';
import type { TaskManager } from '../../tasks.js';
import { classifyTask } from '../../agents.js';
import { getGitStatus } from '../../git.js';
import { config } from '../../config.js';
import { CommandIntentRepository } from '../../infrastructure/database/repositories/intents.js';
import type { JulesSessionService } from './session-service.js';
import { ApplicationError } from '../errors.js';

export interface RoutedExecutionCommand { prompt: string; sessionId: string; idempotencyKey: string; target: 'auto' | 'local' | 'cloud'; }
export class JulesRoutingService {
  constructor(private readonly store: Store, private readonly tasks: TaskManager, private readonly cloud: JulesSessionService) {}
  async execute(projectId: string, command: RoutedExecutionCommand) {
    const project = this.store.getProject(projectId); if (!project) throw new ApplicationError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    const session = this.store.manager.sessions.getById(command.sessionId);
    if (!session || session.projectId !== projectId) throw new ApplicationError('SESSION_PROJECT_MISMATCH', 'Session does not belong to the selected project.', 409);
    const classified = await classifyTask(command.prompt);
    const reasons: string[] = [];
    let target: 'local' | 'cloud' = command.target === 'cloud' ? 'cloud' : 'local';
    if (command.target === 'auto') {
      const status = await getGitStatus(project.root);
      const source = this.store.manager.julesSourceMappings.get(projectId);
      if (!classified.classification.mutating || classified.classification.type === 'question') reasons.push('Read-only and question work stays local for low latency.');
      else if (!status.isGit || status.dirty || !status.head || !status.upstream) reasons.push('Cloud dispatch requires a clean, pushed Git branch.');
      else if (!source || source.targetBranch !== status.branch) reasons.push('No current verified Jules source mapping exists for this branch.');
      else if (this.store.manager.julesCapacity.activeCount() >= config.jules.maxConcurrentSessions) reasons.push('Configured Jules concurrency is currently full.');
      else if (classified.classification.complexity === 'deep') { target = 'cloud'; reasons.push('A deep, mutating, repository-backed task is suitable for long-running Jules execution.'); }
      else reasons.push('Standard interactive work stays local unless Cloud is explicitly selected.');
    } else reasons.push(`The user explicitly selected ${command.target} execution.`);

    if (target === 'cloud') {
      const response = await this.cloud.dispatch(projectId, { prompt: command.prompt, sessionId: command.sessionId,
        requirePlanApproval: true, autoPr: true, idempotencyKey: `route-cloud:${command.idempotencyKey}` });
      this.store.addEvent(String(response.taskId), 'orchestra', 'task.routed', { target, reasons, source: classified.source });
      return { ...response, target, reasons, classification: classified.classification };
    }
    const key = `route-local:${command.idempotencyKey}`;
    const hash = CommandIntentRepository.requestHash({ projectId, ...command, target });
    const existing = this.store.manager.commandIntents.getByIdempotencyKey(key);
    if (existing) {
      if (existing.requestHash !== hash || existing.kind !== 'execution.route') throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused for another execution.', 409);
      if (existing.state === 'acknowledged' && existing.response) return existing.response;
      throw new ApplicationError('ACTION_RECONCILIATION_REQUIRED', 'The execution request is pending reconciliation.', 409);
    }
    let taskId = ''; let response: Record<string, unknown> = {};
    this.store.manager.transaction(() => {
      const task = this.store.createTask(projectId, command.sessionId, command.prompt, JSON.stringify(classified.classification), null, 'local'); taskId = task.id;
      const { intent } = this.store.manager.commandIntents.createOrGet({ taskId, kind: 'execution.route', idempotencyKey: key, requestHash: hash });
      this.store.addMessage({ sessionId: command.sessionId, taskId, role: 'user', agent: 'system', content: command.prompt });
      this.store.addEvent(taskId, 'orchestra', 'task.routed', { target, reasons, source: classified.source });
      response = { ...task, target, reasons, classification: classified.classification };
      this.store.manager.commandIntents.transition(intent.id, 'pending', 'acknowledged', { response });
    });
    this.tasks.enqueue(taskId);
    return response;
  }
}
