import type { DatabaseSync } from 'node:sqlite';

export class JulesCapacityRepository {
  constructor(private readonly db: DatabaseSync) {}
  reserve(taskId: string, limit: number): boolean {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new TypeError('Jules capacity limit is invalid');
    const existing = this.db.prepare('SELECT state FROM jules_capacity_reservations WHERE task_id=?').get(taskId) as { state: string } | undefined;
    if (existing?.state === 'active') return true;
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM jules_capacity_reservations WHERE state='active'").get() as { count: number };
    if (Number(active.count) >= limit) return false;
    const stamp = new Date().toISOString();
    this.db.prepare(`INSERT INTO jules_capacity_reservations (task_id,state,acquired_at,released_at) VALUES (?,'active',?,NULL)
      ON CONFLICT(task_id) DO UPDATE SET state='active',acquired_at=excluded.acquired_at,released_at=NULL`).run(taskId, stamp);
    return true;
  }
  release(taskId: string): boolean {
    const result = this.db.prepare("UPDATE jules_capacity_reservations SET state='released',released_at=? WHERE task_id=? AND state='active'")
      .run(new Date().toISOString(), taskId); return Number(result.changes) === 1;
  }
  restore(taskId: string): void {
    const stamp = new Date().toISOString();
    this.db.prepare(`INSERT INTO jules_capacity_reservations (task_id,state,acquired_at,released_at) VALUES (?,'active',?,NULL)
      ON CONFLICT(task_id) DO UPDATE SET state='active',released_at=NULL`).run(taskId, stamp);
  }
  releaseTerminalTasks(): number {
    const result = this.db.prepare(`UPDATE jules_capacity_reservations SET state='released',released_at=? WHERE state='active'
      AND task_id IN (SELECT id FROM tasks WHERE state IN ('completed','completed_unpushed','failed','cancelled','review_disputed'))`)
      .run(new Date().toISOString()); return Number(result.changes);
  }
  activeCount(): number { const row = this.db.prepare("SELECT COUNT(*) AS count FROM jules_capacity_reservations WHERE state='active'").get() as { count: number }; return Number(row.count); }
}
