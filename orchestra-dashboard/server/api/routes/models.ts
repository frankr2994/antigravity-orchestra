import { Router } from 'express';
import type { Store } from '../../db.js';
import { getAntigravityModels, getCodexModels } from '../../telemetry.js';
import { getInstalledLmStudioModels, loadLmStudioModel, unloadLmStudioModel } from '../../agents.js';
import { listAllMcpServers, toggleMcpServer } from '../../mcp.js';

export function createModelsRouter(store: Store): Router {
  const router = Router();

  router.get('/models', async (_req, res, next) => {
    try {
      const [antigravity, codex, lmStudio] = await Promise.all([
        getAntigravityModels(),
        getCodexModels(),
        getInstalledLmStudioModels().catch(() => []),
      ]);
      res.json({ antigravity, codex, lmStudio });
    } catch (error) {
      next(error);
    }
  });

  router.get('/lmstudio/models', async (_req, res, next) => {
    try {
      const models = await getInstalledLmStudioModels();
      res.json({ models });
    } catch (error) {
      next(error);
    }
  });

  router.post('/lmstudio/load', async (req, res, next) => {
    try {
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
      if (!modelId) return res.status(400).json({ error: 'modelId is required.' });
      const result = await loadLmStudioModel(modelId, { gpu: req.body?.gpu, contextLength: req.body?.contextLength });
      if (result.ok && result.activeModel) {
        store.setSetting('lmStudioModel', result.activeModel);
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/lmstudio/unload', async (req, res, next) => {
    try {
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : undefined;
      const result = await unloadLmStudioModel(modelId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/mcp/servers', async (req, res, next) => {
    try {
      const force = req.query.force === 'true';
      const servers = await listAllMcpServers(force);
      res.json(servers);
    } catch (error) {
      next(error);
    }
  });

  router.post('/mcp/servers/:name/toggle', async (req, res, next) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      const updated = await toggleMcpServer(req.params.name, enabled);
      res.json({ ok: true, server: updated });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
