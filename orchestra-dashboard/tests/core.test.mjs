import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAntigravityArgs, buildAntigravityPrompt, buildCodexReviewArgs, decodeAntigravityProgressLine, decodeCodexProgressLine, extractAntigravityText, friendlyCodexError, interpretAntigravityOutput, normalizeClassification, normalizeEvidenceFile, normalizePostflightResult, normalizeRiskFlags, parseJson, responseIdentifiesProject, sanitizeCodexPath, selectModels, shouldAttemptGemmaAnswer, validateAgentResponse, redactSecrets } from '../dist-server/agents.js';
import { collectRepositoryEvidence } from '../dist-server/evidence.js';
import { initializeGreenfieldRepository, inspectProjectScope, isGreenfieldDirectory, isOrchestraInternalPath, updateManagedGitignore } from '../dist-server/projects.js';
import { getGitStatus, git } from '../dist-server/git.js';
import { Store } from '../dist-server/db.js';
import { evaluateRunHealth, recoveryDisposition, reviewFingerprint } from '../dist-server/tasks.js';

test('model policy escalates deep sensitive work to Pro and Sol', () => {
  const selection = selectModels({ type: 'debug', mutating: true, complexity: 'deep', riskFlags: ['security'], codexRole: 'debug', title: 'Debug auth' });
  assert.equal(selection.antigravity, 'gemini-3.1-pro-high');
  assert.equal(selection.codex, 'gpt-5.6-sol');
  assert.equal(selection.codexEffort, 'high');
});

test('model policy keeps simple questions on Flash without Codex', () => {
  const selection = selectModels({ type: 'question', mutating: false, complexity: 'small', riskFlags: [], codexRole: 'none', title: 'Question' });
  assert.equal(selection.antigravity, 'gemini-3.6-flash-medium');
  assert.equal(selection.codex, null);
});

test('Gemma-first routing is limited to safe small repository questions', () => {
  const safe = { type: 'question', mutating: false, complexity: 'small', riskFlags: [], codexRole: 'none', title: 'Explain repo' };
  assert.equal(shouldAttemptGemmaAnswer(safe, 'Explain this repository'), true);
  assert.equal(shouldAttemptGemmaAnswer(safe, 'Run the build and explain failures'), false);
  assert.equal(shouldAttemptGemmaAnswer(safe, 'Are there commits by this author?'), false);
  assert.equal(shouldAttemptGemmaAnswer({ ...safe, complexity: 'deep' }, 'Explain the architecture'), false);
});

test('classification removes sentinel risk flags and prevents Codex over-routing', () => {
  assert.deepEqual(normalizeRiskFlags(['none', 'N/A', '', 'security']), ['security']);
  const normalized = normalizeClassification({ type: 'question', mutating: false, complexity: 'small', riskFlags: [], codexRole: 'design', title: 'Explain directory' }, 'Can you explain what is in this directory?');
  const selection = selectModels(normalized);
  assert.equal(normalized.codexRole, 'none');
  assert.equal(selection.antigravity, 'gemini-3.6-flash-medium');
  assert.equal(selection.codex, null);
});

test('Codex JSONL decoding exposes friendly progress but not raw commands', () => {
  const raw = JSON.stringify({ type: 'item.started', item: { id: '1', type: 'command_execution', command: 'Get-Content secret-file.txt' } });
  const decoded = decodeCodexProgressLine(raw);
  assert.equal(decoded?.message, 'Inspecting relevant project files.');
  assert.doesNotMatch(decoded?.message || '', /secret-file|Get-Content|command_execution/);
  assert.equal(decodeCodexProgressLine('{"type":"thread.started"}'), null);
});

test('Codex review uses generic read-only exec so stdin instructions remain valid', () => {
  const args = buildCodexReviewArgs({ root: 'F:\\Wiring', model: 'gpt-5.6-sol', effort: 'high', overrideArgs: ['-c', 'mcp_servers.rider.enabled=false'] });
  assert.deepEqual(args.slice(0, 6), ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', 'F:\\Wiring']);
  assert.equal(args.includes('review'), false);
  assert.equal(args.includes('--uncommitted'), false);
  assert.deepEqual(args.slice(-2), ['--json', '-']);
});

test('Codex errors retain the actionable parser line instead of the help footer', () => {
  const stderr = "error: the argument '--uncommitted' cannot be used with '[PROMPT]'\n\nUsage: codex exec review --uncommitted [PROMPT]\n\nFor more information, try '--help'.";
  assert.equal(friendlyCodexError(stderr, 1), "error: the argument '--uncommitted' cannot be used with '[PROMPT]'");
});

test('duplicate recovery requests acknowledge the task that already owns the project', () => {
  assert.equal(recoveryDisposition('recovery_required', false), 'start');
  assert.equal(recoveryDisposition('failed', false), 'start');
  assert.equal(recoveryDisposition('reviewing', true), 'already_active');
  assert.equal(recoveryDisposition('running', true), 'already_active');
  assert.equal(recoveryDisposition('completed', false), 'reject');
});

test('run health distinguishes healthy silence, waiting, stalls, and attention states', () => {
  assert.equal(evaluateRunHealth('reviewing', true, 30_000), 'active');
  assert.equal(evaluateRunHealth('running', true, 100_000), 'waiting');
  assert.equal(evaluateRunHealth('running', true, 310_000), 'possibly_stalled');
  assert.equal(evaluateRunHealth('running', false, 1_000), 'possibly_stalled');
  assert.equal(evaluateRunHealth('recovery_required', false, 1_000), 'needs_attention');
  assert.equal(evaluateRunHealth('completed', false, 1_000), 'complete');
});

test('review finding fingerprints ignore line-number drift but detect changed findings', () => {
  const first = 'VERDICT: BLOCK\n- High: Broken validation [compiler.ts](F:/Wiring/compiler.ts:81)';
  const moved = 'VERDICT: BLOCK\n- High: Broken validation [compiler.ts](F:/Wiring/compiler.ts:99)';
  const different = 'VERDICT: BLOCK\n- High: Missing authorization [server.ts](F:/Wiring/server.ts:99)';
  assert.equal(reviewFingerprint(first), reviewFingerprint(moved));
  assert.notEqual(reviewFingerprint(first), reviewFingerprint(different));
});

test('Antigravity 1.1 stream result extracts and streams the final response', () => {
  const raw = JSON.stringify({ event: 'result', result: { conversation_id: 'conversation-123', status: 'SUCCESS', response: 'This repository is an Android XR application.' } });
  assert.equal(extractAntigravityText(raw), 'This repository is an Android XR application.');
  assert.deepEqual(decodeAntigravityProgressLine(raw), ['This repository is an Android XR application.']);
});

test('read-only Antigravity output survives a late terminal error', () => {
  const raw = JSON.stringify({ event: 'result', result: { conversation_id: 'conversation-123', status: 'ERROR', response: 'Repository F:\\QuestVR\\GameNativeXR has 16 matching commits.' } });
  const result = interpretAntigravityOutput(raw, false);
  assert.match(result.text, /16 matching commits/);
  assert.match(result.warning || '', /preserved the response/);
  assert.throws(() => interpretAntigravityOutput(raw, true), /potentially incomplete file-changing run/);
});

test('Antigravity terminal errors without final text remain failures', () => {
  const raw = JSON.stringify({ event: 'result', result: { status: 'ERROR' } });
  assert.throws(() => interpretAntigravityOutput(raw, false), /without a final response/);
});

test('Antigravity command events do not leak structured protocol', () => {
  const raw = JSON.stringify({ event: 'command_result', command: { name: 'help', data: { secret: 'not-chat-output' } } });
  assert.equal(decodeAntigravityProgressLine(raw), null);
});

test('Antigravity CLI arguments cannot consume an option as the prompt', () => {
  const args = buildAntigravityArgs({ prompt: 'explain this repo', model: 'gemini-3.6-flash-medium', effort: 'medium', mutating: false, conversationId: null });
  assert.equal(args.includes('--print'), false);
  assert.deepEqual(args.slice(-2), ['--prompt', 'explain this repo']);
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits');
  assert.equal(args.includes('--sandbox'), true);
});

test('mutating Antigravity tasks use edit mode without the read-only sandbox', () => {
  const args = buildAntigravityArgs({ prompt: 'implement the feature', model: 'gemini-3.6-flash-high', effort: 'high', mutating: true, conversationId: null });
  assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits');
  assert.equal(args.includes('--sandbox'), false);
});

test('Antigravity prompts prohibit background work and identify recovery runs', () => {
  const prompt = buildAntigravityPrompt({ root: 'F:\\Wiring', prompt: 'Finish the tool', mutating: true, recovery: true });
  assert.match(prompt, /recovery run/i);
  assert.match(prompt, /uncommitted working-tree changes/i);
  assert.match(prompt, /Do not start background tasks, scheduled waits, development\/watch servers/i);
  assert.match(prompt, /cancel or close it before returning/i);
});

test('read-only answers must identify the authoritative active project', () => {
  assert.equal(responseIdentifiesProject('Repository: F:\\QuestVR\\GameNativeXR', 'F:\\QuestVR\\GameNativeXR'), true);
  assert.equal(responseIdentifiesProject('[README](file:///F:/QuestVR/GameNativeXR/README.md)', 'F:\\QuestVR\\GameNativeXR'), true);
  assert.equal(responseIdentifiesProject('Repository: F:\\orchestra', 'F:\\QuestVR\\GameNativeXR'), false);
});

test('postflight deterministically blocks a wrong project before model review', async () => {
  const result = await validateAgentResponse({
    root: 'F:\\QuestVR\\GameNativeXR',
    prompt: 'Explain this repo',
    response: 'Repository: F:\\orchestra',
    evidence: { root: 'F:\\QuestVR\\GameNativeXR', text: '', files: [], includedFiles: [], characterCount: 0, estimatedTokens: 0, truncated: false },
  });
  assert.equal(result.status, 'block');
  assert.equal(result.confidence, 1);
});

test('Gemma evidence paths normalize relative, absolute, and file URI forms', () => {
  const root = 'F:\\QuestVR\\GameNativeXR';
  const files = ['README.md', 'docs/QUEST_APK_VALIDATION.md'];
  assert.equal(normalizeEvidenceFile('README.md', root, files), 'README.md');
  assert.equal(normalizeEvidenceFile('F:\\QuestVR\\GameNativeXR\\README.md', root, files), 'README.md');
  assert.equal(normalizeEvidenceFile('file:///F:/QuestVR/GameNativeXR/docs/QUEST_APK_VALIDATION.md', root, files), 'docs/QUEST_APK_VALIDATION.md');
});

test('postflight discards corroborating observations but retains factual problems', () => {
  const positive = normalizePostflightResult({ status: 'warn', confidence: 0.95, issues: ['The evidence confirms the response accurately identifies the repository and its XR components.'] });
  assert.deepEqual(positive, { status: 'pass', confidence: 0.95, issues: [] });
  const problem = normalizePostflightResult({ status: 'block', confidence: 0.97, issues: ['The response incorrectly claims that missing/File.java exists.'] });
  assert.equal(problem.status, 'block');
  assert.equal(problem.issues.length, 1);
});

test('Gemma JSON parsing repairs raw Windows paths, newlines, and trailing commas', () => {
  const malformed = String.raw`{"answer":"Repository F:\QuestVR\GameNativeXR
Complete.","confidence":0.95,}`;
  const parsed = parseJson(malformed);
  assert.equal(parsed.answer, 'Repository F:\\QuestVR\\GameNativeXR\nComplete.');
  assert.equal(parsed.confidence, 0.95);
});

test('Codex child PATH excludes WindowsApps PowerShell aliases', () => {
  const sanitized = sanitizeCodexPath('C:\\Tools;C:\\Users\\Rob\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\System32');
  assert.equal(sanitized, 'C:\\Tools;C:\\Windows\\System32');
});

test('secret redaction removes common credentials', () => {
  const redacted = redactSecrets('API_KEY=super-secret\ntoken: ghp_abcdefghijklmnopqrstuvwxyz');
  assert.doesNotMatch(redacted, /super-secret|ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.match(redacted, /REDACTED/);
});

test('managed ignore block is idempotent and preserves project rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-ignore-'));
  try {
    writeFileSync(join(root, '.gitignore'), 'custom-output/\n');
    assert.equal(updateManagedGitignore(root), true);
    assert.equal(updateManagedGitignore(root), false);
    const value = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.match(value, /custom-output\//);
    assert.equal((value.match(/BEGIN ANTIGRAVITY ORCHESTRA/g) || []).length, 1);
    assert.doesNotMatch(value, /^\*\.md$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('project scope inspection detects umbrella directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-scope-'));
  try {
    const nested = join(root, 'nested-project');
    writeFileSync(join(root, 'placeholder'), 'x');
    mkdirSync(join(nested, '.git'), { recursive: true });
    const scope = inspectProjectScope(root);
    assert.deepEqual(scope.nestedRepositories, ['nested-project']);
    assert.match(scope.warning, /specific repository root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('greenfield detection accepts only blank or Orchestra-managed directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-greenfield-shape-'));
  try {
    assert.equal(isGreenfieldDirectory(root), true);
    mkdirSync(join(root, '.agents'));
    writeFileSync(join(root, 'AGENTS.md'), '# Rules');
    assert.equal(isGreenfieldDirectory(root), true);
    writeFileSync(join(root, 'package.json'), '{}');
    assert.equal(isGreenfieldDirectory(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Orchestra internal state is excluded from baselines and task commits', () => {
  assert.equal(isOrchestraInternalPath('.orchestra/onboarding.json'), true);
  assert.equal(isOrchestraInternalPath('.orchestra\\backups\\file.txt'), true);
  assert.equal(isOrchestraInternalPath('src/orchestra/index.ts'), false);
  assert.equal(isOrchestraInternalPath('docs/HANDOFF.md'), false);
});

test('greenfield initialization creates a clean main-branch baseline and updates project metadata', async () => {
  const root = mkdtempSync(join(process.cwd(), '.orchestra-greenfield-git-'));
  const store = new Store(join(root, 'store.db'));
  const projectRoot = join(root, 'project');
  mkdirSync(join(projectRoot, '.agents', 'rules'), { recursive: true });
  writeFileSync(join(projectRoot, 'AGENTS.md'), '# Rules');
  writeFileSync(join(projectRoot, '.agents', 'rules', 'workflow.md'), '# Workflow');
  writeFileSync(join(projectRoot, '.gitignore'), '/.orchestra/\n');
  const project = store.upsertProject({ name: 'project', root: projectRoot, gitRoot: null });
  const previous = { authorName: process.env.GIT_AUTHOR_NAME, authorEmail: process.env.GIT_AUTHOR_EMAIL, committerName: process.env.GIT_COMMITTER_NAME, committerEmail: process.env.GIT_COMMITTER_EMAIL, ceiling: process.env.GIT_CEILING_DIRECTORIES };
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'Orchestra Test', GIT_AUTHOR_EMAIL: 'orchestra-test@example.invalid', GIT_COMMITTER_NAME: 'Orchestra Test', GIT_COMMITTER_EMAIL: 'orchestra-test@example.invalid', GIT_CEILING_DIRECTORIES: root });
  try {
    const result = await initializeGreenfieldRepository(store, project);
    const status = await getGitStatus(projectRoot);
    assert.equal(result.initialized, true);
    assert.equal(status.isGit, true);
    assert.equal(status.branch, 'main');
    assert.equal(status.dirty, false);
    assert.ok(status.head);
    assert.equal(store.getProject(project.id)?.gitRoot, status.root);
    const subject = await git(['log', '-1', '--format=%s'], projectRoot);
    assert.equal(subject.stdout.trim(), 'chore: initialize Orchestra');
  } finally {
    for (const [key, value] of Object.entries({ GIT_AUTHOR_NAME: previous.authorName, GIT_AUTHOR_EMAIL: previous.authorEmail, GIT_COMMITTER_NAME: previous.committerName, GIT_COMMITTER_EMAIL: previous.committerEmail, GIT_CEILING_DIRECTORIES: previous.ceiling })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository evidence is bounded, relevant, and excludes sensitive files', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-evidence-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.agents', 'rules'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Sample\nA repository for widgets.');
    writeFileSync(join(root, 'src', 'widget.ts'), 'export const widget = true;');
    writeFileSync(join(root, '.agents', 'rules', 'workflow.md'), '# Agent workflow\nDelegation metadata.');
    writeFileSync(join(root, 'src', 'runtime.so'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, '.env'), 'API_KEY=must-not-appear');
    const packet = collectRepositoryEvidence(root, 'Explain the widget repository', undefined, 20_000);
    assert.match(packet.text, /Authoritative root:/);
    assert.match(packet.text, /README\.md/);
    assert.match(packet.text, /widget\.ts/);
    assert.doesNotMatch(packet.text, /must-not-appear|\.env/);
    assert.equal(packet.files.includes('src/runtime.so'), true);
    assert.equal(packet.includedFiles.includes('src/runtime.so'), false);
    assert.ok(packet.includedFiles.indexOf('README.md') < packet.includedFiles.indexOf('.agents/rules/workflow.md'));
    assert.ok(packet.characterCount <= 20_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SQLite store persists projects, sessions, messages, tasks, and events', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-db-'));
  const path = join(root, 'test.db');
  try {
    const store = new Store(path);
    const project = store.upsertProject({ name: 'sample', root: join(root, 'sample'), gitRoot: null });
    const session = store.createSession(project.id, 'Test');
    const task = store.createTask(project.id, session.id, 'Explain this project');
    store.addMessage({ sessionId: session.id, taskId: task.id, role: 'user', agent: 'system', content: 'Explain this project' });
    const event = store.addEvent(task.id, 'gemma', 'agent.completed', { ok: true });
    assert.equal(store.listProjects().length, 1);
    assert.equal(store.listSessions(project.id)[0].title, 'Test');
    assert.equal(store.listMessages(session.id)[0].content, 'Explain this project');
    assert.deepEqual(store.listEvents(task.id, 0)[0].payload, { ok: true });
    store.setSessionSummary(session.id, '- User wants a repository explanation.');
    assert.match(store.getSession(session.id)?.summary || '', /repository explanation/);
    assert.ok(store.getSession(session.id)?.summaryUpdatedAt);
    assert.ok(event.id > 0);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
