import { Router } from 'express';
import type { Store } from '../../db.js';
import { config } from '../../config.js';
import { getHealth, getStats, getUsage } from '../../telemetry.js';
import { getMcpStatus } from '../../mcp.js';
import { publicSettings } from './settings.js';
import { parseForceRefresh } from '../../application/jules/requests.js';

export interface BootstrapTelemetryExtensions {
  julesUsage?: (force: boolean) => Promise<unknown>;
}

export function createBootstrapRouter(store: Store, extensions: BootstrapTelemetryExtensions = {}): Router {
  const router = Router();

  router.get('/bootstrap', async (_req, res) => {
    res.json({
      token: config.uiToken,
      settings: publicSettings(store),
      projects: store.listProjects(),
      tasks: store.listTasks(),
      health: await getHealth(),
    });
  });

  router.get('/health', async (_req, res) => {
    res.json(await getHealth());
  });

  router.get('/stats', async (_req, res, next) => {
    try {
      res.json(await getStats());
    } catch (error) {
      next(error);
    }
  });

  router.get('/usage', async (req, res, next) => {
    try {
      const force = parseForceRefresh(req.query.force);
      const taskId = typeof req.query.taskId === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.taskId) ? req.query.taskId : undefined;
      res.json(await getUsage(store, extensions.julesUsage ? () => extensions.julesUsage!(force) : undefined, taskId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/mcp/status', async (_req, res, next) => {
    try {
      res.json(await getMcpStatus());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
