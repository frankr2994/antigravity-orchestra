import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { requiredString } from './codec.js';

export interface JulesSourceMapping {
  projectId: string;
  sourceName: string;
  githubOwner: string;
  githubRepo: string;
  startingBranch: string;
  targetBranch: string;
  sourceFingerprint: string;
  verifiedAt: string;
  updatedAt: string;
}

function map(row: unknown): JulesSourceMapping {
  const value = row as Record<string, unknown>;
  return {
    projectId: requiredString(value.project_id, 'source project'),
    sourceName: requiredString(value.source_name, 'source name'),
    githubOwner: requiredString(value.github_owner, 'source owner'),
    githubRepo: requiredString(value.github_repo, 'source repository'),
    startingBranch: requiredString(value.starting_branch, 'source branch'),
    targetBranch: requiredString(value.target_branch, 'source target branch'),
    sourceFingerprint: requiredString(value.source_fingerprint, 'source fingerprint'),
    verifiedAt: requiredString(value.verified_at, 'source verification time'),
    updatedAt: requiredString(value.updated_at, 'source update time'),
  };
}

export class JulesSourceMappingRepository {
  constructor(private readonly db: DatabaseSync) {}

  static fingerprint(input: { sourceName: string; owner: string; repo: string }): string {
    return createHash('sha256').update(`${input.sourceName}\n${input.owner.toLowerCase()}/${input.repo.toLowerCase()}`).digest('hex');
  }

  upsert(input: { projectId: string; sourceName: string; githubOwner: string; githubRepo: string; startingBranch: string; targetBranch?: string; verifiedAt?: string }): JulesSourceMapping {
    const stamp = input.verifiedAt ?? new Date().toISOString();
    const fingerprint = JulesSourceMappingRepository.fingerprint({ sourceName: input.sourceName, owner: input.githubOwner, repo: input.githubRepo });
    this.db.prepare(`INSERT INTO jules_source_mappings
      (project_id,source_name,github_owner,github_repo,starting_branch,target_branch,source_fingerprint,verified_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET source_name=excluded.source_name,github_owner=excluded.github_owner,
        github_repo=excluded.github_repo,starting_branch=excluded.starting_branch,
        target_branch=excluded.target_branch,
        source_fingerprint=excluded.source_fingerprint,verified_at=excluded.verified_at,updated_at=excluded.updated_at`)
      .run(input.projectId, input.sourceName, input.githubOwner, input.githubRepo, input.startingBranch,
        input.targetBranch ?? input.startingBranch, fingerprint, stamp, stamp);
    return this.get(input.projectId)!;
  }

  get(projectId: string): JulesSourceMapping | null {
    const row = this.db.prepare('SELECT * FROM jules_source_mappings WHERE project_id=?').get(projectId);
    return row ? map(row) : null;
  }
}
