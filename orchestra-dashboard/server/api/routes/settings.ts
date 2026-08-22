import { Router } from 'express';
import type { Store } from '../../db.js';
import { config } from '../../config.js';
import { DEFAULT_QUOTA_POLICY, type QuotaPolicy } from '../../agents.js';

export function publicSettings(store: Store) {
  const quotaPolicyJson = store.getSetting('quotaPolicy');
  let quotaPolicy: QuotaPolicy = DEFAULT_QUOTA_POLICY;
  try {
    if (quotaPolicyJson) quotaPolicy = { ...DEFAULT_QUOTA_POLICY, ...JSON.parse(quotaPolicyJson) };
  } catch {
    /* ignore */
  }
  const lmStudioModel = store.getSetting('lmStudioModel') || config.lmStudioModel;
  return {
    lmStudioBaseUrl: config.lmStudioBaseUrl,
    lmStudioModel,
    telemetryInterval: Number(store.getSetting('telemetryInterval') || 2000),
    maxGlobalTasks: config.maxGlobalTasks,
    routingMode: 'automatic',
    quotaPolicy,
  };
}

export function createSettingsRouter(store: Store): Router {
  const router = Router();

  router.get('/settings', (_req, res) => {
    res.json(publicSettings(store));
  });

  router.patch('/settings', (req, res) => {
    const interval = Number(req.body?.telemetryInterval);
    if (Number.isFinite(interval) && interval >= 1000 && interval <= 60_000) {
      store.setSetting('telemetryInterval', String(interval));
    }
    if (typeof req.body?.lmStudioModel === 'string' && req.body.lmStudioModel.trim()) {
      store.setSetting('lmStudioModel', req.body.lmStudioModel.trim());
    }
    if (req.body?.quotaPolicy && typeof req.body.quotaPolicy === 'object') {
      store.setSetting('quotaPolicy', JSON.stringify(req.body.quotaPolicy));
    }
    res.json(publicSettings(store));
  });

  return router;
}
