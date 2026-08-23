import { Router } from 'express';
import type { JulesOperationsService } from '../../../application/jules/operations-service.js';
import { requireJulesCapability, type JulesStageSource } from './capability.js';
export function createJulesOperationsRouter(service: JulesOperationsService, stage: JulesStageSource): Router {
  const router = Router();
  router.get('/jules/operations', (_req, res) => { if (requireJulesCapability(stage, 'read', res)) res.json(service.snapshot()); });
  return router;
}
