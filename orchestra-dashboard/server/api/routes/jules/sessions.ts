import { Router, type NextFunction, type Request, type Response } from 'express';
import type { JulesSessionService } from '../../../application/jules/session-service.js';
import { parseActivityPage, parseDispatchRequest, parseInteractionRequest, parseMessageRequest } from '../../../application/jules/requests.js';
import { requireJulesCapability, type JulesStageSource } from './capability.js';

export function createJulesSessionsRouter(service: JulesSessionService, stage: JulesStageSource): Router {
  const router = Router();
  const id = (value: string | string[]) => Array.isArray(value) ? value[0]! : value;
  router.post('/projects/:id/jules/dispatch', async (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'dispatch', res)) return;
      const header = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      res.status(201).json(await service.dispatch(id(req.params.id), parseDispatchRequest(req.body, header)));
    } catch (error) { next(error); }
  });
  router.get('/tasks/:id/jules-session', (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'read', res)) return;
      res.json(service.getTaskSession(id(req.params.id)));
    } catch (error) { next(error); }
  });
  router.post('/tasks/:id/jules/approve-plan', async (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'interact', res)) return;
      const header = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      res.json(await service.approvePlan(id(req.params.id), parseInteractionRequest(req.body, header).idempotencyKey));
    } catch (error) { next(error); }
  });
  const message = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireJulesCapability(stage, 'interact', res)) return;
      const header = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      const command = parseMessageRequest(req.body, header);
      res.json(await service.sendMessage(id(req.params.id), command.prompt, command.idempotencyKey));
    } catch (error) { next(error); }
  };
  router.post('/tasks/:id/jules/message', message);
  router.post('/tasks/:id/jules/feedback', message);
  const cancel = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireJulesCapability(stage, 'interact', res)) return;
      const header = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
      res.status(200).json(await service.cancel(id(req.params.id), parseInteractionRequest(req.body, header).idempotencyKey));
    } catch (error) { next(error); }
  };
  router.post('/tasks/:id/jules/cancel', cancel);
  router.delete('/tasks/:id/jules-session', cancel);
  router.get('/tasks/:id/jules/activities', async (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'read', res)) return;
      const page = parseActivityPage(req.query as Record<string, unknown>);
      res.json(await service.listActivities(id(req.params.id), page.pageSize, page.pageToken));
    } catch (error) { next(error); }
  });
  return router;
}
