import { Router } from 'express';
import type { Store } from '../db.js';
import { CredentialVault } from '../infrastructure/security/vault.js';
import { JulesApiClient } from '../providers/jules/client.js';
import { JulesSessionManager } from '../providers/jules/session-manager.js';
import { JulesConnectionService } from '../application/jules/connection-service.js';
import { JulesSessionService } from '../application/jules/session-service.js';
import { createJulesConnectionRouter } from '../api/routes/jules/connection.js';
import { createJulesSessionsRouter } from '../api/routes/jules/sessions.js';
import { createJulesReviewRouter } from '../api/routes/jules/review.js';
import { JulesReviewService } from '../application/jules/review-service.js';
import { JulesBatchService } from '../application/jules/batch-service.js';
import { createJulesBatchRouter } from '../api/routes/jules/batches.js';
import { dashboardTokenMiddleware } from '../api/middleware/security.js';
import { JulesOperationsService } from '../application/jules/operations-service.js';
import { createJulesOperationsRouter } from '../api/routes/jules/operations.js';
import type { TaskManager } from '../tasks.js';
import { JulesRoutingService } from '../application/jules/routing-service.js';
import { createJulesRoutingRouter } from '../api/routes/jules/routing.js';
import type { JulesStageSource } from '../api/routes/jules/capability.js';

export interface JulesModuleOptions {
  store?: Store;
  vault?: CredentialVault;
  sessionManager?: JulesSessionManager;
  julesClient?: JulesApiClient;
  rolloutStage?: JulesStageSource;
  reviewService?: JulesReviewService;
  tasks?: TaskManager;
}
function isStore(value: Store | JulesModuleOptions): value is Store { return 'manager' in value; }

export function composeJulesRouter(storeOrOptions?: Store | JulesModuleOptions, explicitVault?: CredentialVault): Router {
  const options: JulesModuleOptions = storeOrOptions
    ? isStore(storeOrOptions) ? { store: storeOrOptions, vault: explicitVault } : storeOrOptions
    : { vault: explicitVault };
  const vault = options.vault ?? new CredentialVault();
  const connection = new JulesConnectionService(options.store, vault, options.julesClient);
  const stage: JulesStageSource = options.rolloutStage ?? (() => connection.runtimeSettings().rolloutStage);
  const router = Router();
  router.use(dashboardTokenMiddleware);
  router.use(createJulesConnectionRouter(connection, stage));
  if (options.store) {
    const manager = options.sessionManager ?? new JulesSessionManager(options.store, vault);
    const sessions = new JulesSessionService(options.store, vault, manager, () => connection.client(), options.julesClient);
    router.use(createJulesSessionsRouter(sessions, stage));
    router.use(createJulesBatchRouter(new JulesBatchService(options.store, sessions), stage));
    router.use(createJulesOperationsRouter(new JulesOperationsService(options.store), stage));
    if (options.tasks) router.use(createJulesRoutingRouter(new JulesRoutingService(options.store, options.tasks, sessions), stage));
  }
  router.use(createJulesReviewRouter(stage, options.reviewService ?? (options.store ? new JulesReviewService(options.store) : undefined)));
  return router;
}
