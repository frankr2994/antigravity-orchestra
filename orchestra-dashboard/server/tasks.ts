/**
 * Stable task API used by HTTP routes and compatibility imports.
 * Execution stages and provider integrations live under application/tasks.
 */
import { TaskExecutionCoordinator } from './application/tasks/task-execution-coordinator.js';

export class TaskManager extends TaskExecutionCoordinator {}

export * from './application/tasks/task-execution-coordinator.js';
