import { Router } from 'express';
import type { JulesRoutingService } from '../../../application/jules/routing-service.js';
import { parseRoutedExecutionRequest } from '../../../application/jules/requests.js';
import type { JulesRolloutStage } from '../../../config.js';
import { requireJulesCapability } from './capability.js';
export function createJulesRoutingRouter(service: JulesRoutingService, stage: JulesRolloutStage): Router {
  const router = Router();
  router.post('/projects/:id/jules/execute', async (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'auto', res)) return;
      const header = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      res.status(202).json(await service.execute(String(req.params.id), parseRoutedExecutionRequest(req.body, header)));
    } catch (error) { next(error); }
  });
  return router;
}
