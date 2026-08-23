import type { Store } from '../../db.js';
import { snapshotJulesMetrics } from '../../providers/jules/metrics.js';

export class JulesOperationsService {
  constructor(private readonly store: Store) {}
  snapshot() {
    const sessions = this.store.manager.cloudSessions.listNonTerminal();
    const now = Date.now();
    return {
      activeSessions: sessions.length,
      oldestActiveSessionMs: sessions.length ? Math.max(...sessions.map((item) => now - Date.parse(item.createdAt))) : 0,
      capacityReservations: this.store.manager.julesCapacity.activeCount(),
      pendingDispatchReconciliation: this.store.manager.commandIntents.listPending().filter((item) => item.kind === 'jules.dispatch').length,
      duePolls: this.store.manager.activityCursors.listDue(new Date().toISOString(), 1000).length,
      runningBatches: this.store.manager.cloudWorkflows.listRunning().length,
      requests: snapshotJulesMetrics(),
    };
  }
}
