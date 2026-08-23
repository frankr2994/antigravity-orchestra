import { Router } from 'express';
import type { JulesRolloutStage } from '../../../config.js';
import { requireJulesCapability } from './capability.js';
import type { JulesReviewService } from '../../../application/jules/review-service.js';

export function createJulesReviewRouter(stage: JulesRolloutStage, service?: JulesReviewService): Router {
  const router = Router();
  router.post('/tasks/:id/jules/import-pr', async (req, res, next) => {
    if (!requireJulesCapability(stage, 'integrate', res)) return;
    if (!service) return res.status(503).json({ error: 'Jules review workflow is not composed.', code: 'JULES_REVIEW_UNAVAILABLE' });
    try { res.status(200).json(await service.reviewAndIntegrate(req.params.id)); }
    catch (error) { next(error); }
  });
  return router;
}
