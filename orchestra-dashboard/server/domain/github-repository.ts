export interface GitHubRepositoryIdentity {
  host: 'github.com';
  owner: string;
  repo: string;
  canonicalUrl: string;
}

const COMPONENT = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;

function identity(owner: string, repository: string): GitHubRepositoryIdentity {
  const repo = repository.replace(/\.git$/, '');
  if (!COMPONENT.test(owner) || !COMPONENT.test(repo) || owner.includes('..') || repo.includes('..')) {
    throw new TypeError('The GitHub remote contains an unsupported owner or repository name.');
  }
  return { host: 'github.com', owner, repo, canonicalUrl: `https://github.com/${owner}/${repo}` };
}

/** Parse only credential-free GitHub clone URLs with an exact owner/repository path. */
export function parseGitHubRepositoryRemote(raw: string): GitHubRepositoryIdentity {
  const value = raw.trim();
  if (!value || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || /%(?:2f|5c|3a|40)/i.test(value)) {
    throw new TypeError('The GitHub remote URL is malformed.');
  }

  const scp = /^git@github\.com:([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  if (scp) return identity(scp[1], scp[2]);

  const ssh = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  if (ssh) return identity(ssh[1], ssh[2]);

  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new TypeError('The GitHub remote URL is malformed.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Only credential-free HTTPS or Git SSH GitHub remotes are supported.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parsed.pathname.includes('\\')) throw new TypeError('The GitHub remote must identify exactly one owner and repository.');
  return identity(parts[0], parts[1]);
}

export function sameGitHubRepository(left: Pick<GitHubRepositoryIdentity, 'owner' | 'repo'>, right: { owner: string; repo: string }): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();
}
