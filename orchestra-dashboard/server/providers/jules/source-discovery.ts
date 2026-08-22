import { git, getGitStatus } from '../../git.js';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import { JulesApiClient } from './client.js';
import { resolveJulesApiKey } from './credentials.js';
import type { JulesSource } from './types.js';

// ============================================================================
// Google Jules Source Repository Discovery & Mapping
// ============================================================================

export type JulesSourceDiscoveryStatus =
  | 'connected'
  | 'remote_missing'
  | 'unsupported_host'
  | 'source_not_installed'
  | 'credentials_missing';

export interface GitRemoteInfo {
  name: string;
  url: string;
  host: string;
  owner?: string;
  repo?: string;
  isGitHub: boolean;
}

export interface JulesSourceDiscoveryResult {
  status: JulesSourceDiscoveryStatus;
  sourceName?: string;
  githubOwner?: string;
  githubRepo?: string;
  remoteUrl?: string;
  sourceResource?: JulesSource;
  availableSources?: JulesSource[];
  diagnostic: string;
  resolution?: string;
}

export function parseGitRemoteUrl(rawUrl: string, remoteName = 'origin'): GitRemoteInfo | null {
  if (!rawUrl || !rawUrl.trim()) return null;
  const clean = rawUrl.trim();

  // 1. SSH format: git@github.com:owner/repo.git or ssh://git@github.com/owner/repo.git
  const sshMatch = clean.match(/^(?:git@|ssh:\/\/git@)([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const owner = sshMatch[2];
    const repo = sshMatch[3];
    return {
      name: remoteName,
      url: clean,
      host,
      owner,
      repo,
      isGitHub: host === 'github.com',
    };
  }

  // 2. HTTPS format: https://github.com/owner/repo.git
  try {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/i, '');
      return {
        name: remoteName,
        url: clean,
        host,
        owner,
        repo,
        isGitHub: host === 'github.com',
      };
    }
    return {
      name: remoteName,
      url: clean,
      host,
      isGitHub: host === 'github.com',
    };
  } catch {
    return null;
  }
}

export async function getProjectGitRemotes(projectRoot: string): Promise<GitRemoteInfo[]> {
  const status = await getGitStatus(projectRoot);
  if (!status.isGit || !status.root) {
    return [];
  }

  const result = await git(['remote', '-v'], status.root).catch(() => null);
  if (!result || result.code !== 0 || !result.stdout.trim()) {
    return [];
  }

  const remotes: GitRemoteInfo[] = [];
  const lines = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    // line format: "origin  https://github.com/owner/repo (fetch)"
    const match = line.match(/^([^\s]+)\s+([^\s]+)\s+\((?:fetch|push)\)$/i);
    if (match) {
      const remoteName = match[1];
      const remoteUrl = match[2];
      const parsed = parseGitRemoteUrl(remoteUrl, remoteName);
      if (parsed && !remotes.some((r) => r.name === remoteName && r.url === remoteUrl)) {
        remotes.push(parsed);
      }
    }
  }

  return remotes;
}

export async function discoverJulesSource(
  projectRoot: string,
  options?: {
    vault?: CredentialVault;
    julesClient?: JulesApiClient;
  }
): Promise<JulesSourceDiscoveryResult> {
  const remotes = await getProjectGitRemotes(projectRoot);

  if (!remotes.length) {
    return {
      status: 'remote_missing',
      diagnostic: 'No Git remote is configured for this project.',
      resolution: "Connect a GitHub repository as 'origin' remote (e.g. `git remote add origin https://github.com/owner/repo.git`).",
    };
  }

  // Prioritize origin, otherwise first remote
  const primaryRemote = remotes.find((r) => r.name === 'origin') || remotes[0];

  if (!primaryRemote.isGitHub || !primaryRemote.owner || !primaryRemote.repo) {
    return {
      status: 'unsupported_host',
      remoteUrl: primaryRemote.url,
      diagnostic: `Remote '${primaryRemote.name}' points to '${primaryRemote.host}', which is not supported by Google Jules.`,
      resolution: 'Google Jules requires a GitHub repository. Add or switch your remote to GitHub (e.g. https://github.com/owner/repo).',
    };
  }

  const githubOwner = primaryRemote.owner;
  const githubRepo = primaryRemote.repo;
  const targetIdentifier = `${githubOwner}/${githubRepo}`.toLowerCase();

  // Check credentials
  let client = options?.julesClient;
  if (!client) {
    const { apiKey } = resolveJulesApiKey(options?.vault);
    if (!apiKey) {
      return {
        status: 'credentials_missing',
        githubOwner,
        githubRepo,
        remoteUrl: primaryRemote.url,
        diagnostic: 'No Google Jules API key is configured.',
        resolution: 'Set the JULES_API_KEY environment variable or save your Jules API key in Settings.',
      };
    }
    client = new JulesApiClient({ apiKey, timeoutMs: 15_000 });
  }

  // Query sources from Jules
  let sources: JulesSource[] = [];
  try {
    sources = await client.listSources();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'credentials_missing',
      githubOwner,
      githubRepo,
      remoteUrl: primaryRemote.url,
      diagnostic: `Failed to query Jules sources: ${message}`,
      resolution: 'Verify your Google Jules API key has access to the Jules REST API.',
    };
  }

  // Match source (case-insensitive)
  const matchedSource = sources.find((source) => {
    // Check 1: sources/github/owner/repo in source.name
    const nameMatch = source.name.toLowerCase().endsWith(`/github/${targetIdentifier}`) ||
      source.name.toLowerCase() === `sources/github/${targetIdentifier}`;
    if (nameMatch) return true;

    // Check 2: source.githubRepo { owner, repo }
    if (source.githubRepo) {
      const srcId = `${source.githubRepo.owner}/${source.githubRepo.repo}`.toLowerCase();
      if (srcId === targetIdentifier) return true;
    }

    return false;
  });

  if (!matchedSource) {
    return {
      status: 'source_not_installed',
      githubOwner,
      githubRepo,
      remoteUrl: primaryRemote.url,
      availableSources: sources,
      diagnostic: `GitHub repository '${githubOwner}/${githubRepo}' is not connected to Google Jules.`,
      resolution: `Install the Google Jules GitHub App on '${githubOwner}/${githubRepo}' at https://jules.google.com to enable cloud worker execution.`,
    };
  }

  return {
    status: 'connected',
    sourceName: matchedSource.name,
    githubOwner,
    githubRepo,
    remoteUrl: primaryRemote.url,
    sourceResource: matchedSource,
    diagnostic: `Successfully mapped project to Jules source '${matchedSource.name}'.`,
  };
}
