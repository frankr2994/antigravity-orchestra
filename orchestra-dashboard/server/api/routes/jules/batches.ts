import { Router } from 'express';
import type { JulesBatchService } from '../../../application/jules/batch-service.js';
import { parseBatchDispatchRequest } from '../../../application/jules/requests.js';
import { requireJulesCapability, type JulesStageSource } from './capability.js';

export function createJulesBatchRouter(service: JulesBatchService, stage: JulesStageSource): Router {
  const router = Router();
  router.post('/projects/:id/jules/dispatch-batch', async (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'parallel', res)) return;
      const header = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      res.status(202).json(await service.createAndLaunch(String(req.params.id), parseBatchDispatchRequest(req.body, header)));
    } catch (error) { next(error); }
  });
  router.get('/jules/batches/:id', (req, res) => {
    if (!requireJulesCapability(stage, 'parallel', res)) return;
    const batch = service.get(String(req.params.id));
    if (!batch) return res.status(404).json({ error: 'Workflow batch not found.', code: 'BATCH_NOT_FOUND' });
    res.json(batch);
  });
  return router;
}
