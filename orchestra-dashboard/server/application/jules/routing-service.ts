import type { Store } from '../../db.js';
import { classifyTask } from '../../agents.js';
import { CommandIntentRepository } from '../../infrastructure/database/repositories/intents.js';
import type { JulesSessionService } from './session-service.js';
import { ApplicationError } from '../errors.js';
import type { LocalTaskQueue } from '../tasks/local-task-queue.js';

export interface RoutedExecutionCommand { prompt: string; sessionId: string; idempotencyKey: string; target: 'auto' | 'local' | 'cloud'; }
export class JulesRoutingService {
  constructor(private readonly store: Store, private readonly tasks: LocalTaskQueue, private readonly cloud: JulesSessionService) {}
  async execute(projectId: string, command: RoutedExecutionCommand) {
    const project = this.store.getProject(projectId); if (!project) throw new ApplicationError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    const session = this.store.manager.sessions.getById(command.sessionId);
    if (!session || session.projectId !== projectId) throw new ApplicationError('SESSION_PROJECT_MISMATCH', 'Session does not belong to the selected project.', 409);
    const classified = await classifyTask(command.prompt);
    const reasons: string[] = [];
    if (command.target === 'cloud') {
      reasons.push('The user explicitly selected cloud execution.');
      const response = await this.cloud.dispatch(projectId, {
        prompt: command.prompt,
        sessionId: command.sessionId,
        requirePlanApproval: true,
        autoPr: true,
        idempotencyKey: `route-cloud:${command.idempotencyKey}`,
      });
      this.store.addEvent(String(response.taskId), 'orchestra', 'task.routed', { target: 'cloud', worker: 'jules', reasons, source: classified.source });
      return { ...response, target: 'cloud', reasons, classification: classified.classification };
    }

    const target = 'local' as const;
    const worker = 'antigravity' as const;
    if (command.target === 'auto') {
      reasons.push('Auto route: Enqueued to the Orchestra multi-agent pipeline for Pass 1 Refinement and Architect Blueprinting.');
    } else {
      reasons.push('The user explicitly selected local execution.');
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
      this.store.addEvent(taskId, 'orchestra', 'task.routed', { target, worker, reasons, source: classified.source });
      response = { ...task, target, reasons, classification: classified.classification };
      this.store.manager.commandIntents.transition(intent.id, 'pending', 'acknowledged', { response });
    });
    this.tasks.enqueue(taskId);
    return response;
  }
}
