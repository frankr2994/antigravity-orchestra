import { Router } from 'express';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import {
  getJulesCredentialStatus,
  resolveJulesApiKey,
  validateJulesApiKey,
} from '../../providers/jules/credentials.js';

export function createJulesRouter(vault?: CredentialVault): Router {
  const router = Router();
  const v = vault ?? new CredentialVault();

  router.get('/jules/credential-status', (_req, res) => {
    res.json(getJulesCredentialStatus(v));
  });

  router.post('/jules/validate-key', async (req, res, next) => {
    try {
      let keyToTest = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
      if (!keyToTest) {
        const current = resolveJulesApiKey(v);
        keyToTest = current.apiKey || '';
      }

      if (!keyToTest) {
        res.status(400).json({ valid: false, error: 'No Jules API key provided or configured.' });
        return;
      }

      const result = await validateJulesApiKey(keyToTest);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/jules/save-key', async (req, res, next) => {
    try {
      const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
      if (!apiKey) {
        res.status(400).json({ error: 'API key cannot be empty.' });
        return;
      }

      // Optional validation before saving
      const validate = Boolean(req.body?.validate ?? true);
      if (validate) {
        const validation = await validateJulesApiKey(apiKey);
        if (!validation.valid) {
          res.status(400).json({ error: `Invalid Jules API key: ${validation.error || 'Failed to authenticate.'}` });
          return;
        }
      }

      v.setSecret('jules_api_key', apiKey);
      res.json({
        ok: true,
        status: getJulesCredentialStatus(v),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/jules/clear-key', (_req, res) => {
    v.removeSecret('jules_api_key');
    res.json({
      ok: true,
      status: getJulesCredentialStatus(v),
    });
  });

  return router;
}
