import { randomUUID } from 'node:crypto';
import type { Store } from '../../db.js';
import { git } from '../../git.js';
import { cleanupIsolatedWorktree } from '../../providers/jules/worktree-review.js';

export class JulesCleanupService {
  constructor(private readonly store: Store) {}
  async tick(): Promise<void> {
    for (const resource of this.store.manager.managedGitResources.listCleanupDue(new Date().toISOString(), 20)) {
      const owner = `jules-cleanup-${randomUUID()}`;
      const lease = this.store.manager.leases.acquire('git_repository', resource.repositoryRoot, owner, 120_000);
      if (!lease) continue;
      try {
        this.store.manager.leases.assertFence('git_repository', resource.repositoryRoot, owner, lease.fencingToken);
        if (resource.kind === 'worktree') {
          await cleanupIsolatedWorktree(resource.repositoryRoot, resource.resourceValue);
        } else if (resource.kind === 'dispatch_ref') {
          if (!/^orchestra\/jules\/[a-z0-9-]+\/[0-9a-f]{12}$/.test(resource.resourceValue)) throw new Error('Unmanaged dispatch ref shape');
          const cloud = this.store.manager.cloudSessions.getByTaskId(resource.taskId);
          if (!cloud) throw new Error('Cloud ownership record missing');
          const ref = `refs/heads/${resource.resourceValue}`;
          const pushUrl = await git(['remote', 'get-url', '--push', 'origin'], resource.repositoryRoot);
          const advertised = await git(['ls-remote', '--heads', pushUrl.stdout.trim(), ref], resource.repositoryRoot);
          const sha = advertised.stdout.trim().split(/\s+/)[0];
          if (sha && sha.toLowerCase() !== cloud.baseSha.toLowerCase()) throw new Error('Managed dispatch ref moved unexpectedly');
          if (sha) {
            const removed = await git(['push', 'origin', '--delete', resource.resourceValue], resource.repositoryRoot, 60_000);
            if (removed.code !== 0) throw new Error('Managed dispatch ref deletion failed');
          }
        } else {
          throw new Error('Managed Git resource kind has no cleanup implementation');
        }
        this.store.manager.managedGitResources.completeCleanup(resource.id, true);
      } catch {
        this.store.manager.managedGitResources.completeCleanup(resource.id, false, 'CLEANUP_RETRY_REQUIRED');
      } finally {
        this.store.manager.leases.release('git_repository', resource.repositoryRoot, owner, lease.fencingToken);
      }
    }
  }
}
