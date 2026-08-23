import { Router } from 'express';
import type { Store } from '../db.js';
import { config, type JulesRolloutStage } from '../config.js';
import { CredentialVault } from '../infrastructure/security/vault.js';
import { JulesApiClient } from '../providers/jules/client.js';
import { JulesSessionManager } from '../providers/jules/session-manager.js';
import { JulesConnectionService } from '../application/jules/connection-service.js';
import { JulesSessionService } from '../application/jules/session-service.js';
import { createJulesConnectionRouter } from '../api/routes/jules/connection.js';
import { createJulesSessionsRouter } from '../api/routes/jules/sessions.js';
import { createJulesReviewRouter } from '../api/routes/jules/review.js';

export interface JulesModuleOptions {
  store?: Store;
  vault?: CredentialVault;
  sessionManager?: JulesSessionManager;
  julesClient?: JulesApiClient;
  rolloutStage?: JulesRolloutStage;
}
function isStore(value: Store | JulesModuleOptions): value is Store { return 'manager' in value; }

export function composeJulesRouter(storeOrOptions?: Store | JulesModuleOptions, explicitVault?: CredentialVault): Router {
  const options: JulesModuleOptions = storeOrOptions
    ? isStore(storeOrOptions) ? { store: storeOrOptions, vault: explicitVault } : storeOrOptions
    : { vault: explicitVault };
  const stage = options.rolloutStage ?? config.jules.rolloutStage;
  const vault = options.vault ?? new CredentialVault();
  const connection = new JulesConnectionService(options.store, vault, options.julesClient);
  const router = Router();
  router.use(createJulesConnectionRouter(connection, stage));
  if (options.store) {
    const manager = options.sessionManager ?? new JulesSessionManager(options.store, vault);
    const sessions = new JulesSessionService(options.store, vault, manager, () => connection.client(), options.julesClient);
    router.use(createJulesSessionsRouter(sessions, stage));
  }
  router.use(createJulesReviewRouter(stage));
  return router;
}
