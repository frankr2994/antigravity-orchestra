import type { DatabaseSync } from 'node:sqlite';

export class SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  delete(key: string) {
    this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
  }
}
