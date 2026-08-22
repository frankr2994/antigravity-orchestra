import test from 'node:test';
import assert from 'node:assert/strict';
import { JulesApiClient, JulesApiError, redactSecrets } from '../dist-server/providers/jules/index.js';

// ============================================================================
// Phase 6 Jules API Client Contract Conformance Test Suite
// ============================================================================

test('Phase 6 Jules Client — redactSecrets scrubs sensitive tokens and keys', () => {
  const secretKey = 'AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz';
  const ghToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz1234';
  const bearer = 'Bearer ya29.a0AfH6SMD1234567890';
  const urlWithKey = 'https://jules.googleapis.com/v1alpha/sources?key=AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz';

  assert.equal(redactSecrets(secretKey), '[REDACTED_API_KEY]');
  assert.equal(redactSecrets(ghToken), '[REDACTED_GH_TOKEN]');
  assert.equal(redactSecrets(bearer), 'Bearer [REDACTED_TOKEN]');
  assert.equal(redactSecrets(urlWithKey), 'https://jules.googleapis.com/v1alpha/sources?key=[REDACTED]');
});

test('Phase 6 Jules Client — Constructor requires non-empty API key', () => {
  assert.throws(() => new JulesApiClient({ apiKey: '' }), /API key is required/i);
  assert.throws(() => new JulesApiClient({ apiKey: '   ' }), /API key is required/i);

  const client = new JulesApiClient({ apiKey: 'test-api-key' });
  assert.equal(client.apiKey, 'test-api-key');
  assert.equal(client.baseUrl, 'https://jules.googleapis.com/v1alpha');
});

test('Phase 6 Jules Client — listSources and createSession wire contract conformance', async () => {
  const requestsMade = [];

  const mockFetch = async (url, options) => {
    requestsMade.push({ url, options });

    if (url.includes('/sources')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sources: [
            {
              name: 'sources/github/owner/test-repo',
              id: 'test-repo',
              displayName: 'test-repo',
              githubRepo: { owner: 'owner', repo: 'test-repo', defaultBranch: 'main' },
            },
          ],
        }),
      };
    }

    if (url.includes('/sessions') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'sessions/session-12345',
          id: 'session-12345',
          state: 'QUEUED',
          prompt: body.prompt,
          sourceContext: body.sourceContext,
          createTime: '2026-08-22T00:00:00Z',
        }),
      };
    }

    return { ok: false, status: 404, statusText: 'Not Found' };
  };

  const client = new JulesApiClient({
    apiKey: 'test-key-123',
    fetchFn: mockFetch,
  });

  // Test 1: listSources
  const sources = await client.listSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, 'sources/github/owner/test-repo');
  assert.equal(requestsMade[0].options.headers['X-Goog-Api-Key'], 'test-key-123');

  // Test 2: createSession
  const session = await client.createSession({
    prompt: 'Refactor database',
    sourceContext: {
      source: 'sources/github/owner/test-repo',
      githubRepoContext: { startingBranch: 'main' },
    },
  });
  assert.equal(session.name, 'sessions/session-12345');
  assert.equal(session.state, 'QUEUED');
});

test('Phase 6 Jules Client — approvePlan, sendFeedback, and activities endpoints', async () => {
  const calls = [];

  const mockFetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });

    if (url.includes(':approvePlan')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.includes(':sendFeedback')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.includes('/activities')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          activities: [
            { name: 'activities/act-1', id: 'act-1', type: 'PLAN_GENERATED', createTime: '2026-08-22T00:00:00Z' },
          ],
        }),
      };
    }
    return { ok: false, status: 404, statusText: 'Not Found' };
  };

  const client = new JulesApiClient({
    apiKey: 'test-key',
    fetchFn: mockFetch,
  });

  await client.approvePlan('sessions/12345');
  assert.equal(calls[0].url, 'https://jules.googleapis.com/v1alpha/sessions/12345:approvePlan');
  assert.equal(calls[0].method, 'POST');

  await client.sendFeedback('12345', 'Please update the migration script.');
  assert.equal(calls[1].url, 'https://jules.googleapis.com/v1alpha/sessions/12345:sendFeedback');
  assert.equal(calls[1].body.message, 'Please update the migration script.');

  const activities = await client.listActivities('12345');
  assert.equal(activities.length, 1);
  assert.equal(activities[0].id, 'act-1');
});

test('Phase 6 Jules Client — Transient error retry and redaction in JulesApiError', async () => {
  let attempts = 0;

  const mockFetch = async () => {
    attempts++;
    if (attempts < 3) {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: { code: 503, message: 'Rate limit on AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ name: 'sessions/retry-success', state: 'IN_PROGRESS' }),
    };
  };

  const client = new JulesApiClient({
    apiKey: 'test-key',
    maxRetries: 3,
    initialBackoffMs: 10,
    maxBackoffMs: 20,
    fetchFn: mockFetch,
  });

  const session = await client.getSession('retry-success');
  assert.equal(session.name, 'sessions/retry-success');
  assert.equal(attempts, 3, 'Should retry until successful attempt 3');

  // Test Non-transient 400 Bad Request throws immediately without retry
  const failFetch = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    json: async () => ({ error: { code: 400, message: 'Invalid prompt for key AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz' } }),
  });

  const failingClient = new JulesApiClient({
    apiKey: 'test-key',
    maxRetries: 3,
    fetchFn: failFetch,
  });

  await assert.rejects(
    async () => failingClient.getSession('fail-task'),
    (err) => {
      assert.ok(err instanceof JulesApiError);
      assert.equal(err.status, 400);
      assert.ok(!err.message.includes('AIzaSy'), 'Error message must redact secret API key');
      assert.ok(err.message.includes('[REDACTED_API_KEY]'));
      return true;
    }
  );
});
