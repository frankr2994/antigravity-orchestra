import { git, getGitStatus } from '../../git.js';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import { JulesApiClient } from './client.js';
import { resolveJulesApiKey } from './credentials.js';
import type { JulesSource } from './types.js';
import { parseGitHubRepositoryRemote, sameGitHubRepository } from '../../domain/github-repository.js';
import { JulesApiError } from './errors.js';

// ============================================================================
// Google Jules Source Repository Discovery & Mapping
// ============================================================================

export type JulesSourceDiscoveryStatus =
  | 'connected'
  | 'remote_missing'
  | 'unsupported_host'
  | 'source_not_installed'
  | 'credentials_missing'
  | 'source_conflict'
  | 'branch_missing'
  | 'provider_unavailable';

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
  try {
    const parsed = parseGitHubRepositoryRemote(rawUrl);
    return { name: remoteName, url: parsed.canonicalUrl, host: parsed.host, owner: parsed.owner, repo: parsed.repo, isGitHub: true };
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
    startingBranch?: string;
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

  // Query all sources from Jules (paginated)
  let sources: JulesSource[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const response = await client.listSources(pageToken);
      if (Array.isArray(response.sources)) {
        sources.push(...response.sources);
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
  } catch (error) {
    return {
      status: error instanceof JulesApiError && (error.status === 401 || error.status === 403) ? 'credentials_missing' : 'provider_unavailable',
      githubOwner,
      githubRepo,
      remoteUrl: primaryRemote.url,
      diagnostic: error instanceof JulesApiError && (error.status === 401 || error.status === 403)
        ? 'Jules rejected the configured credentials.' : 'Jules source discovery is temporarily unavailable.',
      resolution: 'Verify connectivity and credentials, then retry source discovery.',
    };
  }

  // Provider names are opaque. Only the structured repository contract is authoritative.
  const matches = sources.filter((source) => source.githubRepo && sameGitHubRepository(
    { owner: githubOwner, repo: githubRepo },
    source.githubRepo,
  ));
  if (matches.length > 1) {
    return {
      status: 'source_conflict', githubOwner, githubRepo, remoteUrl: primaryRemote.url,
      diagnostic: `Jules returned multiple sources for '${targetIdentifier}'.`,
      resolution: 'Remove the duplicate Jules source installation before dispatching.',
    };
  }
  const matchedSource = matches[0];

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

  if (options?.startingBranch) {
    const branches = matchedSource.githubRepo?.branches?.map((branch) => branch.displayName) ?? [];
    const defaultBranch = matchedSource.githubRepo?.defaultBranch?.displayName;
    if (defaultBranch) branches.push(defaultBranch);
    if (!branches.includes(options.startingBranch)) {
      return {
        status: 'branch_missing', githubOwner, githubRepo, remoteUrl: primaryRemote.url,
        sourceName: matchedSource.name, sourceResource: matchedSource,
        diagnostic: `Branch '${options.startingBranch}' is not advertised by the matched Jules source.`,
        resolution: 'Refresh the Jules source after pushing the branch, then retry dispatch.',
      };
    }
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
