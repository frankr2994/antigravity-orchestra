import type { Server } from 'node:http';
import { config, hasJulesCapability } from '../config.js';
import { Store } from '../db.js';
import { TaskManager } from '../tasks.js';
import { ensureAntigravityStatusCollector } from '../observability.js';
import { closeCodexAppServer } from '../codex-app-server.js';
import { reconcileStartupTasks } from './recovery.js';
import { createApp } from './app.js';
import { JulesSessionManager } from '../providers/jules/session-manager.js';
import { JulesSupervisor } from '../providers/jules/supervisor.js';
import { JulesReviewService } from '../application/jules/review-service.js';
import { CredentialVault } from '../infrastructure/security/vault.js';
import { JulesConnectionService } from '../application/jules/connection-service.js';
import { JulesSessionService } from '../application/jules/session-service.js';
import { JulesBatchService } from '../application/jules/batch-service.js';
import { JulesCleanupService } from '../application/git/jules-cleanup-service.js';

export interface OrchestraServerInstance {
  server: Server;
  store: Store;
  tasks: TaskManager;
  close: () => Promise<void>;
}

export async function bootstrapServer(): Promise<OrchestraServerInstance> {
  const store = new Store();

  // Startup crash recovery reconciliation
  await reconcileStartupTasks(store);

  const tasks = new TaskManager(store, config.maxGlobalTasks);
  let julesSupervisor: JulesSupervisor | null = null;
  if (config.jules.enabled && hasJulesCapability(config.jules.rolloutStage, 'read')) {
    const vault = new CredentialVault();
    const manager = new JulesSessionManager(store, vault);
    const connection = new JulesConnectionService(store, vault);
    const sessions = new JulesSessionService(store, vault, manager, () => connection.client());
    const batches = new JulesBatchService(store, sessions);
    const cleanup = new JulesCleanupService(store);
    const reviewer = new JulesReviewService(store);
    julesSupervisor = new JulesSupervisor({
      store, sessionManager: manager, pollIntervalMs: config.jules.pollIntervalMs,
      maxConcurrentPolls: config.jules.maxConcurrentPolls,
      cleanup: () => cleanup.tick(),
      onTerminal: hasJulesCapability(config.jules.rolloutStage, 'integrate')
        ? async ({ taskId, state, prUrl }) => {
          if (state === 'COMPLETED' && prUrl) {
            await reviewer.reviewAndIntegrate(taskId);
            await batches.reconcileTask(taskId);
          }
        }
        : undefined,
      onError: (error, session) => console.error(`Jules supervisor${session ? ` (${session.remoteSessionId})` : ''}: ${error.message}`),
    });
    julesSupervisor.start();
    if (hasJulesCapability(config.jules.rolloutStage, 'parallel')) {
      for (const batch of store.manager.cloudWorkflows.listRunning()) void batches.launchReady(batch.id);
    }
  }
  const antigravityCollector = ensureAntigravityStatusCollector();
  if (!antigravityCollector.configured) {
    console.warn(`Antigravity telemetry: ${antigravityCollector.reason}`);
  }

  const app = createApp(store, tasks);

  const server = app.listen(config.port, config.host, () => {
    console.log(`Orchestra Command Center: http://${config.host}:${config.port}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Stop the legacy dashboard backend before starting Orchestra.`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });

  function shutdown() {
    julesSupervisor?.stop();
    closeCodexAppServer();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    server,
    store,
    tasks,
    close: async () => {
      julesSupervisor?.stop();
      closeCodexAppServer();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

export * from './app.js';
export * from './recovery.js';
