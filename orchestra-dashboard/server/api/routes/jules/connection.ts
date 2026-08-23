import { Router } from 'express';
import type { JulesConnectionService } from '../../../application/jules/connection-service.js';
import { parseCredentialSaveRequest, parseCredentialValidationRequest } from '../../../application/jules/requests.js';
import type { JulesRolloutStage } from '../../../config.js';
import { requireJulesCapability } from './capability.js';

export function createJulesConnectionRouter(service: JulesConnectionService, stage: JulesRolloutStage): Router {
  const router = Router();
  const id = (value: string | string[]) => Array.isArray(value) ? value[0]! : value;
  router.get('/jules/credential-status', (_req, res) => {
    if (requireJulesCapability(stage, 'connect', res)) res.json(service.credentialStatus());
  });
  router.post('/jules/validate-key', async (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'connect', res)) return;
      const input = parseCredentialValidationRequest(req.body);
      res.json(await service.validateCredential(input.apiKey));
    } catch (error) { next(error); }
  });
  router.post('/jules/save-key', async (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'connect', res)) return;
      const input = parseCredentialSaveRequest(req.body);
      res.json({ ok: true, status: await service.saveCredential(input.apiKey, input.validate) });
    } catch (error) { next(error); }
  });
  router.delete('/jules/clear-key', (_req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'connect', res)) return;
      res.json({ ok: true, status: service.clearCredential() });
    } catch (error) { next(error); }
  });
  router.get('/projects/:id/jules-source', async (req, res, next) => {
    try {
      if (!requireJulesCapability(stage, 'read', res)) return;
      res.json(await service.discoverProjectSource(id(req.params.id)));
    } catch (error) { next(error); }
  });
  return router;
}
