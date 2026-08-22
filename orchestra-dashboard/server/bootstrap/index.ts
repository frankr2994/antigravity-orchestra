import type { Server } from 'node:http';
import { config } from '../config.js';
import { Store } from '../db.js';
import { TaskManager } from '../tasks.js';
import { ensureAntigravityStatusCollector } from '../observability.js';
import { closeCodexAppServer } from '../codex-app-server.js';
import { reconcileStartupTasks } from './recovery.js';
import { createApp } from './app.js';

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
      closeCodexAppServer();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

export * from './app.js';
export * from './recovery.js';
