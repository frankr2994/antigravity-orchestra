import { Router } from 'express';
import type { Store } from '../../db.js';
import type { TaskManager } from '../../tasks.js';
import { createBootstrapRouter } from './bootstrap.js';
import { createProjectsRouter } from './projects.js';
import { createSessionsRouter } from './sessions.js';
import { createTasksRouter } from './tasks.js';
import { createModelsRouter } from './models.js';
import { createSettingsRouter } from './settings.js';
import { createJulesRouter } from './jules.js';

export function createApiRouter(store: Store, tasks: TaskManager): Router {
  const router = Router();

  router.use(createBootstrapRouter(store));
  router.use(createProjectsRouter(store));
  router.use(createSessionsRouter(store, tasks));
  router.use(createTasksRouter(store, tasks));
  router.use(createModelsRouter(store));
  router.use(createSettingsRouter(store));
  router.use(createJulesRouter(store));

  return router;
}

export * from './bootstrap.js';
export * from './projects.js';
export * from './sessions.js';
export * from './tasks.js';
export * from './models.js';
export * from './settings.js';
export * from './jules.js';
