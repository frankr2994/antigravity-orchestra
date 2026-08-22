import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Project } from '../../../domain/index.js';

function now() { return new Date().toISOString(); }

function mapProject(row: unknown): Project {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    name: String(r.name),
    root: String(r.root),
    gitRoot: r.git_root ? String(r.git_root) : null,
    onboardingStatus: String(r.onboarding_status),
    onboardingVersion: r.onboarding_version ? String(r.onboarding_version) : null,
    activeSessionId: r.active_session_id ? String(r.active_session_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(mapProject);
  }

  getById(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return row ? mapProject(row) : null;
  }

  getByRoot(root: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE root=?').get(root);
    return row ? mapProject(row) : null;
  }

  upsert(input: { name: string; root: string; gitRoot: string | null }): Project {
    const existing = this.getByRoot(input.root);
    const stamp = now();
    if (existing) {
      this.db.prepare('UPDATE projects SET name=?, git_root=?, updated_at=? WHERE id=?')
        .run(input.name, input.gitRoot, stamp, existing.id);
      return this.getById(existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO projects
      (id,name,root,git_root,onboarding_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, input.name, input.root, input.gitRoot, 'pending', stamp, stamp);
    return this.getById(id)!;
  }

  updateOnboarding(id: string, status: string, version: string | null) {
    this.db.prepare('UPDATE projects SET onboarding_status=?, onboarding_version=?, updated_at=? WHERE id=?')
      .run(status, version, now(), id);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
  }
}
