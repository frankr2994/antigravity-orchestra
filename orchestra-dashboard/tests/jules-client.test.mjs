import test from 'node:test';
import assert from 'node:assert/strict';
import { JulesApiClient, JulesApiError, JulesContractError, redactSecrets } from '../dist-server/providers/jules/index.js';

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

test('Phase 6 Jules Client — Constructor requires non-empty API key and hides private key property', () => {
  assert.throws(() => new JulesApiClient({ apiKey: '' }), /API key is required/i);
  assert.throws(() => new JulesApiClient({ apiKey: '   ' }), /API key is required/i);

  const client = new JulesApiClient({ apiKey: 'test-api-key' });
  // ApiKey should not be a public enumerable property
  assert.equal(client.apiKey, undefined);
  assert.equal(Object.keys(client).includes('apiKey'), false);
  assert.equal(client.baseUrl, 'https://jules.googleapis.com/v1alpha');
});

test('Phase 6 Jules Client — listSources, getSource, and createSession wire contract conformance', async () => {
  const requestsMade = [];

  const mockFetch = async (url, options) => {
    requestsMade.push({ url, options });

    if (url.includes('/sources/github/owner/test-repo')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'sources/github/owner/test-repo',
          id: 'test-repo',
          githubRepo: { owner: 'owner', repo: 'test-repo', defaultBranch: { displayName: 'main' } },
        }),
      };
    }

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
              githubRepo: { owner: 'owner', repo: 'test-repo', defaultBranch: { displayName: 'main' } },
            },
          ],
          nextPageToken: 'token-page-2',
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
          automationMode: body.automationMode,
          outputs: [],
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

  // Test 1: listSources with pagination preservation
  const sourcesRes = await client.listSources();
  assert.equal(sourcesRes.sources.length, 1);
  assert.equal(sourcesRes.sources[0].name, 'sources/github/owner/test-repo');
  assert.equal(sourcesRes.nextPageToken, 'token-page-2');
  assert.equal(requestsMade[0].options.headers['X-Goog-Api-Key'], 'test-key-123');

  // Test 2: getSource
  const source = await client.getSource('sources/github/owner/test-repo');
  assert.equal(source.name, 'sources/github/owner/test-repo');
  assert.equal(source.githubRepo?.defaultBranch?.displayName, 'main');

  // Test 3: createSession with automationMode
  const session = await client.createSession({
    prompt: 'Refactor database',
    sourceContext: {
      source: 'sources/github/owner/test-repo',
      githubRepoContext: { startingBranch: 'main' },
    },
    automationMode: 'AUTO_CREATE_PR',
  });
  assert.equal(session.name, 'sessions/session-12345');
  assert.equal(session.state, 'QUEUED');
  assert.equal(session.automationMode, 'AUTO_CREATE_PR');
});

test('Phase 6 Jules Client — approvePlan, sendMessage, deleteSession, and activities endpoints', async () => {
  const calls = [];

  const mockFetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });

    if (url.includes(':approvePlan')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.includes(':sendMessage')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.includes('/sessions/12345') && options.method === 'DELETE') {
      return { ok: true, status: 204 };
    }
    if (url.includes('/activities')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          activities: [
            {
              name: 'sessions/12345/activities/act-1',
              id: 'act-1',
              originator: 'agent',
              planGenerated: {
                plan: {
                  id: 'plan-1',
                  steps: [{ index: 0, title: 'Analyze requirements', status: 'COMPLETED' }],
                },
              },
              createTime: '2026-08-22T00:00:00Z',
            },
          ],
          nextPageToken: 'token-act-2',
        }),
      };
    }
    return { ok: false, status: 404, statusText: 'Not Found' };
  };

  const client = new JulesApiClient({
    apiKey: 'test-key',
    fetchFn: mockFetch,
  });

  // 1. approvePlan
  await client.approvePlan('sessions/12345');
  assert.equal(calls[0].url, 'https://jules.googleapis.com/v1alpha/sessions/12345:approvePlan');
  assert.equal(calls[0].method, 'POST');

  // 2. sendMessage (authoritative endpoint with { prompt })
  await client.sendMessage('12345', 'Please update the migration script.');
  assert.equal(calls[1].url, 'https://jules.googleapis.com/v1alpha/sessions/12345:sendMessage');
  assert.equal(calls[1].body.prompt, 'Please update the migration script.');

  // 3. deleteSession
  await client.deleteSession('12345');
  assert.equal(calls[2].url, 'https://jules.googleapis.com/v1alpha/sessions/12345');
  assert.equal(calls[2].method, 'DELETE');

  // 4. listActivities with pagination
  const actRes = await client.listActivities('12345');
  assert.equal(actRes.activities.length, 1);
  assert.equal(actRes.activities[0].id, 'act-1');
  assert.equal(actRes.activities[0].originator, 'agent');
  assert.equal(actRes.activities[0].planGenerated?.plan?.steps?.length, 1);
  assert.equal(actRes.nextPageToken, 'token-act-2');

  // 5. Incremental activity polling uses Jules' immutable createTime cursor.
  await client.listActivities('12345', 100, undefined, undefined, '2026-08-22T00:00:00Z');
  assert.match(calls[4].url, /createTime=2026-08-22T00%3A00%3A00Z/);
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
        json: async () => ({
          error: {
            code: 503,
            message: 'Rate limit on AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz',
            details: [{ secret: 'sk-proj-sensitive12345' }],
          },
        }),
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
    json: async () => ({
      error: {
        code: 400,
        message: 'Invalid prompt for key AIzaSyB1234567890abcdefghijklmnopqrstuvwxyz',
        details: [{ token: 'ghp_secrettoken999' }],
      },
    }),
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
      assert.deepEqual(err.details, [{ token: '[REDACTED]' }], 'Semantic secret fields must be fully redacted');
      return true;
    }
  );
});

test('Stage A Jules contracts — malformed successful responses fail closed', async () => {
  const clientFor = (body) => new JulesApiClient({
    apiKey: 'test-key',
    maxRetries: 0,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => body }),
  });

  await assert.rejects(
    () => clientFor({ name: 42, state: { bad: true } }).getSession('bad'),
    (error) => error instanceof JulesContractError && error.code === 'JULES_CONTRACT_INVALID',
  );
  await assert.rejects(() => clientFor({}).listSources(), JulesContractError);
  await assert.rejects(
    () => clientFor({ sessions: [{ name: 'sessions/good', state: { bad: true } }] }).listSessions(),
    JulesContractError,
  );
  await assert.rejects(
    () => clientFor({ activities: [{
      name: 'sessions/s1/activities/a1',
      originator: 'agent',
      userMessaged: { message: 'wrong documented field' },
    }] }).listActivities('s1'),
    JulesContractError,
  );
  await assert.rejects(
    () => clientFor({ activities: [{
      name: 'sessions/s1/activities/a1',
      originator: 'agent',
      userMessaged: { userMessage: 'one' },
      agentMessaged: { agentMessage: 'two' },
    }] }).listActivities('s1'),
    JulesContractError,
  );
});

test('Stage A Jules contracts — documented messages and future activities are represented safely', async () => {
  const client = new JulesApiClient({
    apiKey: 'test-key',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        activities: [
          {
            name: 'sessions/s1/activities/user-1',
            originator: 'user',
            userMessaged: { userMessage: 'Please add integration tests' },
          },
          {
            name: 'sessions/s1/activities/agent-1',
            originator: 'agent',
            agentMessaged: { agentMessage: 'The tests are ready' },
          },
          {
            name: 'sessions/s1/activities/future-1',
            originator: 'system',
            futureProviderEvent: { token: 'must-not-cross-the-boundary' },
          },
        ],
      }),
    }),
  });

  const result = await client.listActivities('s1');
  assert.equal(result.activities[0].userMessaged.userMessage, 'Please add integration tests');
  assert.equal(result.activities[1].agentMessaged.agentMessage, 'The tests are ready');
  assert.deepEqual(result.activities[2].unknownActivity.fields, ['futureProviderEvent']);
  assert.equal('futureProviderEvent' in result.activities[2], false);
  assert.equal(JSON.stringify(result.activities[2]).includes('must-not-cross-the-boundary'), false);
});

test('Stage A Jules client — mutating requests are not blindly retried', async () => {
  let attempts = 0;
  const client = new JulesApiClient({
    apiKey: 'test-key',
    maxRetries: 3,
    fetchFn: async () => {
      attempts += 1;
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: { message: 'ambiguous mutation' } }),
      };
    },
  });
  await assert.rejects(() => client.createSession({
    prompt: 'test',
    sourceContext: { source: 'sources/github/owner/repo' },
  }), JulesApiError);
  assert.equal(attempts, 1);
});
