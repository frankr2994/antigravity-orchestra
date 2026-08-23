import { Router } from 'express';
import type { JulesConnectionService } from '../../../application/jules/connection-service.js';
import { parseCredentialSaveRequest, parseCredentialValidationRequest, parseJulesEnabledRequest } from '../../../application/jules/requests.js';
import type { JulesStageSource } from './capability.js';
import { requireJulesCapability } from './capability.js';

export function createJulesConnectionRouter(service: JulesConnectionService, stage: JulesStageSource): Router {
  const router = Router();
  const id = (value: string | string[]) => Array.isArray(value) ? value[0]! : value;
  router.get('/jules/credential-status', (_req, res) => {
    res.json(service.credentialStatus());
  });
  router.get('/jules/settings', (_req, res) => res.json(service.runtimeSettings()));
  router.patch('/jules/settings', (req, res, next) => {
    try { res.json(service.setRuntimeEnabled(parseJulesEnabledRequest(req.body).enabled)); }
    catch (error) { next(error); }
  });
  router.post('/jules/validate-key', async (req, res, next) => {
    try {
      const input = parseCredentialValidationRequest(req.body);
      res.json(await service.validateCredential(input.apiKey));
    } catch (error) { next(error); }
  });
  router.post('/jules/save-key', async (req, res, next) => {
    try {
      const input = parseCredentialSaveRequest(req.body);
      res.json({ ok: true, status: await service.saveCredential(input.apiKey, input.validate) });
    } catch (error) { next(error); }
  });
  router.delete('/jules/clear-key', (_req, res, next) => {
    try {
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
