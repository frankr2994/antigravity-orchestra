import type { DatabaseSync } from 'node:sqlite';

export class JulesActivityReceiptRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(cloudSessionId: string, activityId: string, createTime?: string | null): boolean {
    if (!activityId.trim()) throw new TypeError('A stable Jules activity identity is required');
    const result = this.db.prepare(`INSERT INTO jules_activity_receipts
      (cloud_session_id,activity_id,create_time,received_at) VALUES (?,?,?,?)
      ON CONFLICT(cloud_session_id,activity_id) DO NOTHING`)
      .run(cloudSessionId, activityId, createTime ?? null, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  count(cloudSessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM jules_activity_receipts WHERE cloud_session_id=?').get(cloudSessionId) as { count: number };
    return Number(row.count);
  }
}
