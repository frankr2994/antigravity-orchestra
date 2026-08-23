import { Router } from 'express';
import type { JulesRolloutStage } from '../../../config.js';
import { requireJulesCapability } from './capability.js';

export function createJulesReviewRouter(stage: JulesRolloutStage): Router {
  const router = Router();
  router.post('/tasks/:id/jules/import-pr', (_req, res) => {
    if (!requireJulesCapability(stage, 'review', res)) return;
    res.status(501).json({
      error: 'PR import is unavailable until exact provider-owned PR identity and durable review are enabled.',
      code: 'JULES_PR_IMPORT_UNAVAILABLE',
    });
  });
  return router;
}
