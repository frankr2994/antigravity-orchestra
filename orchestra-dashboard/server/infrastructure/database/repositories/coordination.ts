import type { DatabaseSync } from 'node:sqlite';
import type { ActivityCursor, ResourceLease } from '../../../domain/index.js';
import { nullableString, requiredString } from './codec.js';

function now() { return new Date().toISOString(); }
function mapCursor(row: unknown): ActivityCursor {
  const value = row as Record<string, unknown>;
  return {
    cloudSessionId: requiredString(value.cloud_session_id, 'cursor session'),
    nextPageToken: nullableString(value.next_page_token), lastActivityId: nullableString(value.last_activity_id),
    lastActivityAt: nullableString(value.last_activity_at), nextPollAt: requiredString(value.next_poll_at, 'next poll time'),
    consecutiveFailures: Number(value.consecutive_failures), lastErrorCode: nullableString(value.last_error_code),
    version: Number(value.version), updatedAt: requiredString(value.updated_at, 'cursor update time'),
  };
}

export class ActivityCursorRepository {
  constructor(private readonly db: DatabaseSync) {}
  ensure(cloudSessionId: string, nextPollAt = now()): ActivityCursor {
    const stamp = now();
    this.db.prepare(`INSERT INTO activity_cursors (cloud_session_id,next_poll_at,updated_at)
      VALUES (?,?,?) ON CONFLICT(cloud_session_id) DO NOTHING`).run(cloudSessionId, nextPollAt, stamp);
    return this.get(cloudSessionId)!;
  }
  get(cloudSessionId: string): ActivityCursor | null {
    const row = this.db.prepare('SELECT * FROM activity_cursors WHERE cloud_session_id=?').get(cloudSessionId);
    return row ? mapCursor(row) : null;
  }
  listDue(at = now(), limit = 100): ActivityCursor[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Cursor limit must be between 1 and 1000');
    return this.db.prepare('SELECT * FROM activity_cursors WHERE next_poll_at<=? ORDER BY next_poll_at LIMIT ?').all(at, limit).map(mapCursor);
  }
  compareAndSet(cloudSessionId: string, expectedVersion: number, fields: {
    nextPageToken?: string | null; lastActivityId?: string | null; lastActivityAt?: string | null;
    nextPollAt: string; consecutiveFailures: number; lastErrorCode?: string | null;
  }): ActivityCursor {
    const result = this.db.prepare(`UPDATE activity_cursors SET next_page_token=?,last_activity_id=?,last_activity_at=?,
      next_poll_at=?,consecutive_failures=?,last_error_code=?,version=version+1,updated_at=?
      WHERE cloud_session_id=? AND version=?`).run(fields.nextPageToken ?? null, fields.lastActivityId ?? null,
        fields.lastActivityAt ?? null, fields.nextPollAt, fields.consecutiveFailures, fields.lastErrorCode ?? null,
        now(), cloudSessionId, expectedVersion);
    if (Number(result.changes) !== 1) throw new Error(`Activity cursor ${cloudSessionId} changed concurrently`);
    return this.get(cloudSessionId)!;
  }
}

function mapLease(row: unknown): ResourceLease {
  const value = row as Record<string, unknown>;
  return {
    resourceType: requiredString(value.resource_type, 'lease type'), resourceId: requiredString(value.resource_id, 'lease resource'),
    ownerId: requiredString(value.owner_id, 'lease owner'), fencingToken: Number(value.fencing_token),
    expiresAt: requiredString(value.expires_at, 'lease expiry'), acquiredAt: requiredString(value.acquired_at, 'lease acquired time'),
  };
}

export class ResourceLeaseRepository {
  constructor(private readonly db: DatabaseSync) {}
  acquire(resourceType: string, resourceId: string, ownerId: string, durationMs: number, at = new Date()): ResourceLease | null {
    if (!ownerId || !Number.isFinite(durationMs) || durationMs <= 0) throw new TypeError('Lease owner and positive duration are required');
    const stamp = at.toISOString(); const expires = new Date(at.getTime() + durationMs).toISOString();
    const row = this.db.prepare(`INSERT INTO resource_leases
      (resource_type,resource_id,owner_id,fencing_token,expires_at,acquired_at) VALUES (?,?,?,1,?,?)
      ON CONFLICT(resource_type,resource_id) DO UPDATE SET
        owner_id=excluded.owner_id,
        fencing_token=CASE WHEN resource_leases.owner_id=excluded.owner_id AND resource_leases.expires_at>excluded.acquired_at
          THEN resource_leases.fencing_token ELSE resource_leases.fencing_token+1 END,
        expires_at=excluded.expires_at,
        acquired_at=CASE WHEN resource_leases.owner_id=excluded.owner_id AND resource_leases.expires_at>excluded.acquired_at
          THEN resource_leases.acquired_at ELSE excluded.acquired_at END
      WHERE resource_leases.owner_id=excluded.owner_id OR resource_leases.expires_at<=excluded.acquired_at
      RETURNING *`).get(resourceType, resourceId, ownerId, expires, stamp);
    return row ? mapLease(row) : null;
  }
  get(resourceType: string, resourceId: string): ResourceLease | null {
    const row = this.db.prepare('SELECT * FROM resource_leases WHERE resource_type=? AND resource_id=?').get(resourceType, resourceId);
    return row ? mapLease(row) : null;
  }
  assertFence(resourceType: string, resourceId: string, ownerId: string, fencingToken: number, at = now()): void {
    const row = this.db.prepare(`SELECT 1 AS valid FROM resource_leases
      WHERE resource_type=? AND resource_id=? AND owner_id=? AND fencing_token=? AND expires_at>?`)
      .get(resourceType, resourceId, ownerId, fencingToken, at);
    if (!row) throw new Error(`Stale lease fence for ${resourceType}:${resourceId}`);
  }
  release(resourceType: string, resourceId: string, ownerId: string, fencingToken: number): boolean {
    const result = this.db.prepare(`UPDATE resource_leases SET expires_at='1970-01-01T00:00:00.000Z'
      WHERE resource_type=? AND resource_id=? AND owner_id=? AND fencing_token=?`)
      .run(resourceType, resourceId, ownerId, fencingToken);
    return Number(result.changes) === 1;
  }
}
