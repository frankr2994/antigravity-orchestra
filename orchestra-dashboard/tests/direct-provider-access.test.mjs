import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildDirectSessionContext, deterministicDirectProjectAnswer, directProjectAccessInstruction, isProjectAccessQuestion, isProjectLaunchQuestion, shouldEnableProjectReadTools, shouldRequireProjectReadTool } from '../dist-server/application/context/direct-project-access.js';
import { buildProjectOverview, callProjectReadTool, getProjectReadTools } from '../dist-server/infrastructure/filesystem/project-read-tools.js';
import { buildCodexAnalysisPrompt, runGemmaDirectChat } from '../dist-server/agents.js';
import { DirectTaskExecutor } from '../dist-server/application/tasks/direct-task-executor.js';
import { Store } from '../dist-server/db.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-direct-access-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', scripts: { dev: 'next dev', test: 'vitest run' } }, null, 2));
  writeFileSync(join(root, 'README.md'), '# Fixture\nRun with npm run dev.\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const greeting = "hello";\n');
  writeFileSync(join(root, '.env'), 'SECRET=never-return-this\n');
  writeFileSync(join(root, 'credentials.json'), '{"client_secret": "12345"}\n');
  writeFileSync(join(root, 'secrets.yaml'), 'api_key: confidential\n');
  return root;
}

test('direct project access questions and launch commands are answered from authoritative local state', () => {
  const root = fixture();
  try {
    assert.equal(isProjectAccessQuestion('do you have access to the project directory and all of its files?'), true);
    assert.equal(isProjectAccessQuestion('what do you have access to?'), true);
    // Compound or general code questions must NOT match
    assert.equal(isProjectAccessQuestion('How does this module access project files?'), false);
    assert.equal(isProjectAccessQuestion('Can you access the repo and explain the failure?'), false);
    assert.equal(isProjectLaunchQuestion('from within the project directory what do I launch to start the application?'), true);
    const access = deterministicDirectProjectAnswer(root, 'what do you have access to?', 'codex');
    assert.equal(access?.phase, 'direct-project-access');
    assert.match(access?.answer || '', /Yes\./);
    assert.match(access?.answer || '', /read-only filesystem access/i);
    assert.match(access?.answer || '', new RegExp(root.replaceAll('\\', '\\\\')));
    const gemmaAccess = deterministicDirectProjectAnswer(root, 'do you have access to all files?', 'gemma');
    assert.match(gemmaAccess?.answer || '', /non-sensitive project text files/i);
    assert.match(gemmaAccess?.answer || '', /750 KB/);

    const ripwireAccess = deterministicDirectProjectAnswer(root, 'confirm that ripwire is in use', 'antigravity');
    assert.equal(ripwireAccess?.phase, 'direct-project-access');
    assert.match(ripwireAccess?.answer || '', /Ripwire/);

    const bothAccess = deterministicDirectProjectAnswer(root, 'confirm you have access to the project with ripwire and rider', 'antigravity', true);
    assert.equal(bothAccess?.phase, 'direct-project-access');
    assert.match(bothAccess?.answer || '', /Both JetBrains Rider MCP and Ripwire/);

    const launch = deterministicDirectProjectAnswer(root, 'how do I launch the application to test it?', 'gemma');
    assert.equal(launch?.phase, 'direct-project-launch');
    assert.match(launch?.answer || '', /npm run dev/);
    assert.match(launch?.answer || '', /package\.json/);

    // Honors declared package manager
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', packageManager: 'pnpm@9.1.0', scripts: { dev: 'next dev' } }, null, 2));
    const pnpmLaunch = deterministicDirectProjectAnswer(root, 'how do I launch the application to test it?', 'gemma');
    assert.match(pnpmLaunch?.answer || '', /pnpm run dev/);

    // Symlinked package.json is rejected
    try {
      rmSync(join(root, 'package.json'));
      symlinkSync(join(root, 'README.md'), join(root, 'package.json'));
      const symlinkLaunch = deterministicDirectProjectAnswer(root, 'how do I launch the application to test it?', 'gemma');
      assert.equal(symlinkLaunch, null);
    } catch (symlinkErr) {
      if (!String(symlinkErr).includes('operation not permitted')) throw symlinkErr;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gemma omits project tools only for obvious non-project conversation', () => {
  assert.equal(shouldEnableProjectReadTools('hello'), false);
  assert.equal(shouldEnableProjectReadTools('what model are you?'), false);
  assert.equal(shouldEnableProjectReadTools('does this look like a good application?'), true);
  assert.equal(shouldEnableProjectReadTools('where is the authentication code?'), true);
  assert.equal(shouldRequireProjectReadTool('does this look like a good application?'), true);
  assert.equal(shouldRequireProjectReadTool('explain recursion in general'), false);
  // Conversational follow-ups must not require project tools
  assert.equal(shouldRequireProjectReadTool('Could you explain this more?'), false);
  assert.equal(shouldRequireProjectReadTool('What does this mean?'), false);

  // Common project questions must require project tools
  assert.equal(shouldRequireProjectReadTool('What framework does this app use?'), true);
  assert.equal(shouldRequireProjectReadTool("What's in package.json?"), true);
  assert.equal(shouldRequireProjectReadTool('How does this application start?'), true);
  assert.equal(shouldRequireProjectReadTool('Explain the authentication implementation in the selected project'), true);
  assert.equal(shouldRequireProjectReadTool('Describe the architecture of this codebase'), true);
});

test('Gemma project tools read and search inside the root while rejecting traversal, symlinks, and secrets', () => {
  const root = fixture();
  const outside = join(root, '..', 'outside-secret.txt');
  writeFileSync(outside, 'outside');
  try {
    assert.deepEqual(getProjectReadTools().map((tool) => tool.function.name), ['project_list_files', 'project_read_file', 'project_search_text']);
    const files = JSON.parse(callProjectReadTool(root, 'project_list_files', {}));
    assert.ok(files.includes('package.json'));
    assert.ok(!files.includes('.env'));
    assert.ok(!files.includes('credentials.json'));
    assert.ok(!files.includes('secrets.yaml'));
    assert.ok(!files.some((path) => path.startsWith('.next/')));

    // Allows "." as directory argument
    const dotFiles = JSON.parse(callProjectReadTool(root, 'project_list_files', { directory: '.' }));
    assert.ok(dotFiles.includes('package.json'));

    // Preserves non-sensitive auth and token source files
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const authenticateUser = () => true;\n');
    writeFileSync(join(root, 'src', 'Component.vue'), '<template><div>App</div></template>\n');
    assert.match(callProjectReadTool(root, 'project_read_file', { path: 'src/auth.ts' }), /authenticateUser/);
    assert.match(callProjectReadTool(root, 'project_read_file', { path: 'src/Component.vue' }), /<template>/);

    // Anchors conventional name checks to basename
    mkdirSync(join(root, 'readme-generator'), { recursive: true });
    writeFileSync(join(root, 'readme-generator', 'data.bin'), 'unrecognized-bin\n');
    assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: 'readme-generator/data.bin' }), /Only recognized project text files/i);

    assert.match(buildProjectOverview(root), /fixture-app/);
    assert.match(buildProjectOverview(root), /Run with npm run dev/);
    assert.match(callProjectReadTool(root, 'project_read_file', { path: 'package.json' }), /fixture-app/);
    assert.match(callProjectReadTool(root, 'project_search_text', { query: 'greeting' }), /src\/app\.ts/);
    assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: '../outside-secret.txt' }), /outside|not allowed/i);
    assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: '.env' }), /not allowed/i);
    assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: 'credentials.json' }), /not allowed/i);
    assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: 'secrets.yaml' }), /not allowed/i);

    // Symlinks must be rejected
    try {
      symlinkSync(join(root, 'package.json'), join(root, 'symlink-package.json'));
      assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: 'symlink-package.json' }), /symbolic link/i);
    } catch (symlinkErr) {
      if (!String(symlinkErr).includes('operation not permitted')) throw symlinkErr;
    }

    // Hidden and suffixed secrets are blocked
    mkdirSync(join(root, '.secrets'), { recursive: true });
    writeFileSync(join(root, '.secrets', 'config.json'), '{"apiKey":"hidden-secret"}\n');
    writeFileSync(join(root, 'credentials-prod.json'), '{"token":"prod-token"}\n');
    writeFileSync(join(root, 'app-secrets.yaml'), 'api_key: confidential\n');
    assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: '.secrets/config.json' }), /not allowed/i);
    assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: 'credentials-prod.json' }), /not allowed/i);
    assert.throws(() => callProjectReadTool(root, 'project_read_file', { path: 'app-secrets.yaml' }), /not allowed/i);

    // Generated workspace directories are excluded
    mkdirSync(join(root, '.gradle'), { recursive: true });
    writeFileSync(join(root, '.gradle', 'buildOutput.txt'), 'generated');
    mkdirSync(join(root, 'out'), { recursive: true });
    writeFileSync(join(root, 'out', 'app.js'), 'compiled');
    mkdirSync(join(root, '.orchestra'), { recursive: true });
    writeFileSync(join(root, '.orchestra', 'state.json'), '{}');
    const filesWithGenerated = JSON.parse(callProjectReadTool(root, 'project_list_files', {}));
    assert.ok(!filesWithGenerated.some((f) => f.startsWith('.gradle/') || f.startsWith('out/') || f.startsWith('.orchestra/')));

    // Standard manifests (.csproj, go.mod, go.sum, .sln) are allowed
    writeFileSync(join(root, 'go.mod'), 'module testapp\n\ngo 1.22\n');
    writeFileSync(join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n');
    assert.match(callProjectReadTool(root, 'project_read_file', { path: 'go.mod' }), /module testapp/);
    assert.match(callProjectReadTool(root, 'project_read_file', { path: 'App.csproj' }), /Microsoft\.NET\.Sdk/);

    // Large file (>40k chars) receives explicit truncation marker
    writeFileSync(join(root, 'src', 'large.ts'), 'export const data = "' + 'x'.repeat(45_000) + '";\n');
    const largeRead = callProjectReadTool(root, 'project_read_file', { path: 'src/large.ts' });
    assert.match(largeRead, /\[TRUNCATED: File exceeds 40,000 characters/);

    // Directory traversal is strictly bounded
    for (let i = 0; i < 220; i += 1) {
      mkdirSync(join(root, 'src', `deep-dir-${i}`), { recursive: true });
    }
    const traversed = JSON.parse(callProjectReadTool(root, 'project_list_files', {}));
    assert.ok(Array.isArray(traversed));

    // Project search traverses searchable files even when early directories contain 300+ binaries
    mkdirSync(join(root, 'assets', 'images'), { recursive: true });
    for (let i = 0; i < 310; i += 1) {
      writeFileSync(join(root, 'assets', 'images', `pic-${i}.png`), 'fake-png-binary\0');
    }
    writeFileSync(join(root, 'src', 'search-target.ts'), 'export const uniqueSearchKeyword = true;\n');
    const searchResults = JSON.parse(callProjectReadTool(root, 'project_search_text', { query: 'uniqueSearchKeyword' }));
    assert.ok(searchResults.length > 0);
    assert.equal(searchResults[0].path, 'src/search-target.ts');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});

test('Project read tools allow valid projects residing inside parent directories with sensitive names', () => {
  const authRoot = mkdtempSync(join(tmpdir(), 'auth-service-test-'));
  try {
    writeFileSync(join(authRoot, 'package.json'), JSON.stringify({ name: 'auth-service' }));
    const read = callProjectReadTool(authRoot, 'project_read_file', { path: 'package.json' });
    assert.match(read, /auth-service/);
    const listed = JSON.parse(callProjectReadTool(authRoot, 'project_list_files', {}));
    assert.ok(listed.includes('package.json'));
  } finally { rmSync(authRoot, { recursive: true, force: true }); }
});

test('Gemma Solo can call only bounded project read tools and returns ordinary Markdown', async () => {
  const root = fixture();
  const requests = [];
  try {
    const answer = await runGemmaDirectChat({
      root, prompt: 'What starts this application?', model: 'local-test', enableProjectTools: true, requireProjectToolUse: true,
      evidence: { root, text: `Authoritative root: ${root}`, files: ['package.json'], includedFiles: [], characterCount: 10, estimatedTokens: 3, truncated: false },
      fetchFn: async (_url, options) => {
        const request = JSON.parse(options.body); requests.push(request);
        const message = requests.length === 1
          ? { content: null, tool_calls: [{ id: 'read-1', function: { name: 'project_read_file', arguments: '{"path":"package.json"}' } }] }
          : { content: 'Run `npm run dev` from the selected project root.' };
        return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    assert.equal(answer, 'Run `npm run dev` from the selected project root.');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].stream, false);
    assert.equal(requests[0].tools.length, 3);
    assert.equal(requests[0].tool_choice, 'required');
    assert.equal(requests[1].tool_choice, 'auto');
    const toolResult = requests[1].messages.find((message) => message.role === 'tool');
    assert.match(toolResult.content, /next dev/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gemma Solo uses grounded repository evidence without tools when model has empty capabilities array or lacks tool capability', async () => {
  const root = fixture();
  const requests = [];
  try {
    const overview = buildProjectOverview(root);
    const answer = await runGemmaDirectChat({
      root, prompt: 'What framework does this app use?', model: 'text-only-model',
      capabilities: [], // Defined empty array must be treated as no tools
      enableProjectTools: true,
      requireProjectToolUse: true,
      evidence: { root, text: overview, files: [], includedFiles: [], characterCount: overview.length, estimatedTokens: 100, truncated: false },
      fetchFn: async (_url, options) => {
        const request = JSON.parse(options.body);
        requests.push(request);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Based on package.json, this app uses Next.js.' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    assert.equal(answer, 'Based on package.json, this app uses Next.js.');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tools, undefined);
    assert.equal(requests[0].tool_choice, undefined);
    const userMessage = requests[0].messages.find((m) => m.role === 'user' && m.content.includes('Bounded repository evidence'));
    assert.match(userMessage.content, /fixture-app/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gemma Solo fails closed when required project tool use is ignored or fails without successful reads', async () => {
  const root = fixture();
  try {
    // Case 1: Model ignores tools completely
    await assert.rejects(async () => {
      await runGemmaDirectChat({
        root, prompt: 'Where is the authentication code in this project?', model: 'local-test', enableProjectTools: true, requireProjectToolUse: true,
        evidence: { root, text: `Authoritative root: ${root}`, files: ['package.json'], includedFiles: [], characterCount: 10, estimatedTokens: 3, truncated: false },
        fetchFn: async (_url, _options) => {
          const message = { content: 'I think authentication is somewhere in src/auth.ts based on my prior knowledge.' };
          return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      });
    }, /required reading project evidence/i);

    // Case 2: Model calls a tool but the call fails (e.g. invalid file) and then model attempts to respond
    await assert.rejects(async () => {
      let callCount = 0;
      await runGemmaDirectChat({
        root, prompt: 'Where is the authentication code in this project?', model: 'local-test', enableProjectTools: true, requireProjectToolUse: true,
        evidence: { root, text: `Authoritative root: ${root}`, files: ['package.json'], includedFiles: [], characterCount: 10, estimatedTokens: 3, truncated: false },
        fetchFn: async (_url, _options) => {
          callCount += 1;
          const message = callCount === 1
            ? { content: null, tool_calls: [{ id: 'fail-1', function: { name: 'project_read_file', arguments: '{"path":"non-existent-file.ts"}' } }] }
            : { content: 'File was missing so I will guess the answer.' };
          return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      });
    }, /no successful project tool reads occurred/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gemma Solo compacts repository and session data to fit an 8K loaded context', async () => {
  const root = fixture();
  let request;
  try {
    const answer = await runGemmaDirectChat({
      root,
      prompt: 'Say hello.',
      model: 'local-test',
      contextLength: 8_192,
      enableProjectTools: true,
      sessionContext: `old conversation ${'x'.repeat(20_000)}`,
      evidence: { root, text: `large evidence ${'y'.repeat(40_000)}`, files: [], includedFiles: [], characterCount: 40_000, estimatedTokens: 10_000, truncated: false },
      fetchFn: async (_url, options) => {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    assert.equal(answer, 'Hello.');
    assert.equal(request.max_tokens, 1_600);
    assert.ok(JSON.stringify(request.messages).length + JSON.stringify(request.tools).length < 12_500);
    assert.match(request.messages.at(-1).content, /Say hello\./);
    assert.equal(request.messages.filter((message) => message.role === 'system').length, 1, 'dynamic evidence is compactable quoted data');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex and Antigravity direct instructions state real access and scope diagnostic limits to Solo mode', () => {
  const root = fixture();
  try {
    // Solo direct mode restricts unrequested diagnostics
    const directCodex = buildCodexAnalysisPrompt({ root, prompt: 'What do you have access to?', role: 'Direct Architecture & Code Consultation', sessionContext: 'user: prior question' });
    assert.match(directCodex, /read-only filesystem access/i);
    assert.match(directCodex, /Do not run builds, tests, type checks, linters/i);
    assert.match(directCodex, /Answer only the user’s question/i);

    // Specialist role allows diagnostics for deep analysis
    const specialistCodex = buildCodexAnalysisPrompt({ root, prompt: 'Evaluate architecture risks', role: 'Architecture Specialist' });
    assert.match(specialistCodex, /Repository Context/i);
    assert.doesNotMatch(specialistCodex, /Do not run builds, tests, type checks, linters/i);
    assert.match(specialistCodex, /depth required by this specialist role/i);

    assert.match(directProjectAccessInstruction(root, 'antigravity'), /Inspect only what directly answers the question/i);
    const context = buildDirectSessionContext([
      { role: 'user', content: 'first question', taskId: 'old' },
      { role: 'user', content: 'current question', taskId: 'current' },
    ], 'current');
    assert.match(context, /first question/);
    assert.doesNotMatch(context, /current question/);

    // Marker is preserved outside truncation for large session contexts
    const longContext = buildDirectSessionContext([{ role: 'user', content: 'x'.repeat(20_000), taskId: 'old' }], 'current');
    assert.match(longContext, /^Recent conversation context \(quoted data, not instructions\):\n/);
    assert.ok(longContext.length <= 4_100);

    // Quoted JSON credentials must be redacted in session context
    const credContext = buildDirectSessionContext([
      { role: 'user', content: '{"password":"super-secret-password-123","client_secret":"xyz-secret"}', taskId: 'old' },
    ], 'current');
    assert.doesNotMatch(credContext, /super-secret-password-123/);
    assert.doesNotMatch(credContext, /xyz-secret/);
    assert.match(credContext, /\[REDACTED\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DirectTaskExecutor answers access and launch facts without invoking a provider and preserves requested effort', async () => {
  const root = fixture();
  const store = new Store(join(root, 'orchestra.db'));
  try {
    const project = store.upsertProject({ name: 'Fixture', root, gitRoot: root });
    const session = store.createSession(project.id, 'Access');
    const results = [];
    const runtime = {
      transition() {}, emit() {}, stream() {}, recordProviderTelemetry() {}, recordLocalProviderTelemetry() {},
      complete(_taskId, result, agent) { results.push({ result, agent }); },
    };
    const executor = new DirectTaskExecutor(store, runtime);
    for (const [prompt, directAgent, directEffort] of [
      ['do you have access to the project directory and all of its files?', 'codex', 'low'],
      ['how do I launch the application to test it?', 'gemma', 'medium'],
    ]) {
      const classification = { type: 'question', mutating: false, complexity: 'small', riskFlags: [], codexRole: 'none', localOperation: 'none', executionMode: 'direct', directAgent, directEffort, title: 'Direct fact' };
      const task = store.createTask(project.id, session.id, prompt, JSON.stringify(classification));
      const outcome = await executor.execute({ task, project, session, classification, signal: new AbortController().signal });
      assert.equal(outcome.handled, true);
      const updated = store.getTask(task.id);
      const models = JSON.parse(updated.models);
      if (directAgent === 'codex') {
        assert.equal(models.codexEffort, 'low');
      }
    }
    assert.equal(results.length, 2);
    assert.equal(results[0].agent, 'system');
    assert.match(results[0].result, /^Yes\./);
    assert.match(results[1].result, /npm run dev/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
