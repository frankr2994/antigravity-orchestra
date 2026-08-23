import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitRemoteUrl,
  discoverJulesSource,
} from '../dist-server/providers/jules/source-discovery.js';
import { JulesApiClient } from '../dist-server/providers/jules/client.js';

// ============================================================================
// Phase 8 Jules Source Discovery & Mapping Test Suite
// ============================================================================

test('Phase 8 Source Discovery — parseGitRemoteUrl handles HTTPS and SSH Git remote URLs', () => {
  // 1. HTTPS with .git
  const httpsGit = parseGitRemoteUrl('https://github.com/google/antigravity.git');
  assert.equal(httpsGit?.isGitHub, true);
  assert.equal(httpsGit?.owner, 'google');
  assert.equal(httpsGit?.repo, 'antigravity');

  // 2. HTTPS without .git
  const httpsPlain = parseGitRemoteUrl('https://github.com/facebook/react');
  assert.equal(httpsPlain?.isGitHub, true);
  assert.equal(httpsPlain?.owner, 'facebook');
  assert.equal(httpsPlain?.repo, 'react');

  // 3. SSH syntax
  const sshGit = parseGitRemoteUrl('git@github.com:torvalds/linux.git');
  assert.equal(sshGit?.isGitHub, true);
  assert.equal(sshGit?.owner, 'torvalds');
  assert.equal(sshGit?.repo, 'linux');

  // 4. Non-GitHub and credential-bearing remotes fail closed
  assert.equal(parseGitRemoteUrl('https://gitlab.com/group/project.git'), null);
  assert.equal(parseGitRemoteUrl('https://token@github.com/group/project.git'), null);
  assert.equal(parseGitRemoteUrl('http://github.com/group/project.git'), null);
  assert.equal(parseGitRemoteUrl('https://github.com/group/project/extra'), null);

  // 5. Invalid URL
  assert.equal(parseGitRemoteUrl('not-a-valid-url'), null);
});

test('Phase 8 Source Discovery — discoverJulesSource connects matching GitHub repository with case insensitivity', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      sources: [
        {
          name: 'sources/github/FrankR2994/antigravity-orchestra',
          id: 'antigravity-orchestra',
          githubRepo: {
            owner: 'FrankR2994',
            repo: 'antigravity-orchestra',
            defaultBranch: { displayName: 'main' },
          },
        },
      ],
    }),
  });

  const julesClient = new JulesApiClient({
    apiKey: 'test-key',
    fetchFn: mockFetch,
  });

  // Test against current orchestra repository root (which is a real git repo)
  const result = await discoverJulesSource(process.cwd(), { julesClient });

  // In our local clone, remote is https://github.com/frankr2994/antigravity-orchestra
  assert.equal(result.status, 'connected');
  assert.equal(result.sourceName, 'sources/github/FrankR2994/antigravity-orchestra');
  assert.ok(result.sourceResource);
});

test('Phase 8 Source Discovery — discoverJulesSource returns source_not_installed when repo not in Jules sources', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      sources: [
        {
          name: 'sources/github/some-other-owner/unrelated-repo',
          githubRepo: { owner: 'some-other-owner', repo: 'unrelated-repo' },
        },
      ],
    }),
  });

  const julesClient = new JulesApiClient({
    apiKey: 'test-key',
    fetchFn: mockFetch,
  });

  const result = await discoverJulesSource(process.cwd(), { julesClient });
  assert.equal(result.status, 'source_not_installed');
  assert.match(result.resolution || '', /Install the Google Jules GitHub App/i);
});

test('Phase 8 Source Discovery — discoverJulesSource returns credentials_missing when API key missing or invalid', async () => {
  const mockFailFetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({ error: { message: 'Invalid API Key' } }),
  });

  const julesClient = new JulesApiClient({
    apiKey: 'bad-key',
    fetchFn: mockFailFetch,
  });

  const result = await discoverJulesSource(process.cwd(), { julesClient });
  assert.equal(result.status, 'credentials_missing');
  assert.match(result.diagnostic, /rejected the configured credentials/i);
});

test('Phase 8 Source Discovery — opaque source names cannot override structured repository identity', async () => {
  const julesClient = new JulesApiClient({ apiKey: 'test-key', fetchFn: async () => ({
    ok: true, status: 200, json: async () => ({ sources: [{
      name: 'sources/github/frankr2994/antigravity-orchestra',
      githubRepo: { owner: 'attacker', repo: 'different' },
    }] }),
  }) });
  const result = await discoverJulesSource(process.cwd(), { julesClient });
  assert.equal(result.status, 'source_not_installed');
});
