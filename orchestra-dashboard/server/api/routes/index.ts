import { Router } from 'express';
import type { Store } from '../../db.js';
import type { TaskManager } from '../../tasks.js';
import { createBootstrapRouter } from './bootstrap.js';
import { createProjectsRouter } from './projects.js';
import { createSessionsRouter } from './sessions.js';
import { createTasksRouter } from './tasks.js';
import { createModelsRouter } from './models.js';
import { createSettingsRouter } from './settings.js';
import { composeJulesRouter } from '../../bootstrap/jules-module.js';
import type { JulesRolloutStage } from '../../config.js';

export interface ApiRouterOptions {
  julesEnabled?: boolean;
  julesRolloutStage?: JulesRolloutStage;
}

export function createApiRouter(store: Store, tasks: TaskManager, options: ApiRouterOptions = {}): Router {
  const router = Router();
  const fixedStage = options.julesEnabled === false ? 'off' : options.julesRolloutStage;

  router.use(createBootstrapRouter(store));
  router.use(createProjectsRouter(store));
  router.use(createSessionsRouter(store, tasks));
  router.use(createTasksRouter(store, tasks));
  router.use(createModelsRouter(store));
  router.use(createSettingsRouter(store));
  // Connection settings are always mounted so Jules can be enabled entirely
  // from the dashboard. Operational routes resolve the persisted stage per request.
  router.use(composeJulesRouter({ store, tasks, rolloutStage: fixedStage }));

  return router;
}

export * from './bootstrap.js';
export * from './projects.js';
export * from './sessions.js';
export * from './tasks.js';
export * from './models.js';
export * from './settings.js';
