import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { Store } from '../db.js';
import type { TaskManager } from '../tasks.js';
import { hostValidationMiddleware, apiAuthMiddleware } from '../api/middleware/security.js';
import { errorHandlerMiddleware } from '../api/middleware/error.js';
import { createApiRouter } from '../api/routes/index.js';

export function createApp(store: Store, tasks: TaskManager): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(hostValidationMiddleware);
  app.use('/api', apiAuthMiddleware);

  // Mount modular API routes
  app.use('/api', createApiRouter(store, tasks));

  // Static web UI
  const publicDir = join(config.dashboardRoot, 'dist');
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false }));
    app.get('*path', (_req, res) => res.sendFile(join(publicDir, 'index.html')));
  }

  // Error middleware
  app.use(errorHandlerMiddleware);

  return app;
}
