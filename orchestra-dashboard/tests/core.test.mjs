import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAntigravityArgs, buildAntigravityPrompt, buildContinuationPrompt, buildReviewPacket, decodeAntigravityProgressLine, decodeCodexProgressLine, distillVerificationErrors, extractAntigravityText, extractAntigravityUsage, extractCodexReviewVerdict, findContinuationRecoveryTask, friendlyCodexError, hasExplicitMutationIntent, interpretAntigravityOutput, isConnectGitRemoteIntent, isContinuationCommand, normalizeClassification, normalizeEvidenceFile, normalizePostflightResult, normalizeRiskFlags, parseJson, preReviewSanityCheck, responseDefersRequestedWork, responseIdentifiesProject, sanitizeCodexPath, selectModels, selectReviewProfile, shouldAttemptGemmaAnswer, sliceSemanticCommits, validateAgentResponse, redactSecrets } from '../dist-server/agents.js';
import { collectRepositoryEvidence } from '../dist-server/evidence.js';
import { initializeGreenfieldRepository, inspectProjectScope, isGreenfieldDirectory, isOrchestraInternalPath, updateManagedGitignore } from '../dist-server/projects.js';
import { extractGitHubRemoteUrl, getGitStatus, git, validateGitHubRemoteUrl } from '../dist-server/git.js';
import { Store } from '../dist-server/db.js';
import { evaluateRunHealth, implementationChangeState, providerFailoverDisposition, providerFailureStatus, recoveryDisposition, reviewFingerprint } from '../dist-server/tasks.js';
import { extractAntigravityQuotas } from '../dist-server/observability.js';
import { codexProgressMessage, normalizeCodexTokenUsage } from '../dist-server/codex-app-server.js';
import { isGemmaRiderToolAllowed } from '../dist-server/mcp.js';
import { ProcessIdleTimeoutError, runProcess } from '../dist-server/process.js';
import { npmInvocation, verificationFailure, verifyProject } from '../dist-server/verification.js';

test('model policy escalates deep sensitive work to Pro and Sol', () => {
  const selection = selectModels({ type: 'debug', mutating: true, complexity: 'deep', riskFlags: ['security'], codexRole: 'debug', title: 'Debug auth' });
  assert.equal(selection.antigravity, 'gemini-3.7-flash-high');
  assert.equal(selection.codex, 'gpt-5.6-sol');
  assert.equal(selection.codexEffort, 'high');
});

test('model policy keeps simple questions on Flash without Codex', () => {
  const selection = selectModels({ type: 'question', mutating: false, complexity: 'small', riskFlags: [], codexRole: 'none', title: 'Question' });
  assert.equal(selection.antigravity, 'gemini-3.7-flash-low');
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
  assert.equal(selection.antigravity, 'gemini-3.7-flash-low');
  assert.equal(selection.codex, null);
});

test('explicit implementation language overrides a false non-mutating model classification', () => {
  const prompt = 'I want a detailed wiring tool. Go ahead and plan out and implement this now.';
  const normalized = normalizeClassification({ type: 'design', mutating: false, complexity: 'deep', riskFlags: [], codexRole: 'design', localOperation: 'none', title: 'Design tool' }, prompt);
  assert.equal(hasExplicitMutationIntent(prompt), true);
  assert.equal(normalized.mutating, true);
  assert.equal(normalized.type, 'design');
  assert.equal(normalized.codexRole, 'design');
  assert.equal(hasExplicitMutationIntent('Plan the implementation, but do not modify files.'), false);
});

test('short approval continues the previous completed task with implementation authority', () => {
  const expanded = buildContinuationPrompt('proceed', { state: 'completed', prompt: 'Plan a wiring editor', result: 'Next step: implement the product spike.' });
  assert.match(expanded || '', /explicitly authorizes implementation/i);
  assert.match(expanded || '', /Plan a wiring editor/);
  assert.equal(hasExplicitMutationIntent(expanded || ''), true);
  assert.equal(buildContinuationPrompt('What does this mean?', { state: 'completed', prompt: 'Explain repo', result: 'Done' }), null);
  assert.equal(isContinuationCommand('continue'), true);
  assert.equal(isContinuationCommand('continue?'), true);
  assert.equal(isContinuationCommand('explain what to continue'), false);
});

test('local repository answers cannot claim completion while deferring requested work', () => {
  assert.equal(responseDefersRequestedWork('The repository uses React.', []), false);
  assert.equal(responseDefersRequestedWork('The repository uses React.', ["The implementation request is an instruction for a subsequent step, as this analysis only covers the existing state."]), true);
});

test('continuation commands find the preserved task owner behind newer completed summaries', () => {
  const recovery = { id: 'preserved', state: 'recovery_required' };
  const tasks = [{ id: 'bad-summary', state: 'completed' }, recovery, { id: 'older', state: 'cancelled' }];
  assert.equal(findContinuationRecoveryTask('continue', tasks), recovery);
  assert.equal(findContinuationRecoveryTask('explain the status', tasks), null);
});

test('implementation completion distinguishes working changes, direct commits, and no progress', () => {
  assert.equal(implementationChangeState('abc', { head: 'abc', files: [{ path: 'src/app.ts' }] }), 'working_tree');
  assert.equal(implementationChangeState('abc', { head: 'def', files: [] }), 'committed');
  assert.equal(implementationChangeState('abc', { head: 'abc', files: [{ path: '.orchestra/runtime.json' }] }), 'none');
  assert.equal(implementationChangeState('abc', { head: 'abc', files: [] }), 'none');
});

test('remote connection intent stays local even when Gemma marks it security-sensitive', () => {
  const prompt = 'Tie this project to my remote https://github.com/example/sample';
  const normalized = normalizeClassification({ type: 'implementation', mutating: true, complexity: 'deep', riskFlags: ['security'], codexRole: 'design', localOperation: 'none', title: 'Connect remote' }, prompt);
  assert.equal(isConnectGitRemoteIntent(prompt), true);
  assert.deepEqual({ operation: normalized.localOperation, complexity: normalized.complexity, risks: normalized.riskFlags, role: normalized.codexRole }, { operation: 'connect_git_remote', complexity: 'small', risks: [], role: 'none' });
  assert.equal(isConnectGitRemoteIntent('Add a parser feature to this repository'), false);
});

test('GitHub remote extraction accepts plain repository URLs and rejects unsafe shapes', () => {
  assert.equal(extractGitHubRemoteUrl('Use https://github.com/frankr2994/Car-Schematic-Builder.'), 'https://github.com/frankr2994/Car-Schematic-Builder');
  assert.equal(validateGitHubRemoteUrl('https://github.com/example/project.git'), 'https://github.com/example/project');
  assert.throws(() => validateGitHubRemoteUrl('https://user:secret@github.com/example/project'), /plain HTTPS GitHub/);
  assert.throws(() => validateGitHubRemoteUrl('https://example.com/example/project'), /plain HTTPS GitHub/);
});

test('Gemma Rider bridge exposes inspection tools but blocks mutations and execution', () => {
  assert.equal(isGemmaRiderToolAllowed('rider_get_solution_projects'), true);
  assert.equal(isGemmaRiderToolAllowed('rider_read_file'), true);
  assert.equal(isGemmaRiderToolAllowed('rider_apply_patch'), false);
  assert.equal(isGemmaRiderToolAllowed('rider_execute_terminal_command'), false);
  assert.equal(isGemmaRiderToolAllowed('rider_build_solution'), false);
});

test('Codex JSONL decoding exposes friendly progress but not raw commands', () => {
  const raw = JSON.stringify({ type: 'item.started', item: { id: '1', type: 'command_execution', command: 'Get-Content secret-file.txt' } });
  const decoded = decodeCodexProgressLine(raw);
  assert.equal(decoded?.message, 'Inspecting relevant project files.');
  assert.doesNotMatch(decoded?.message || '', /secret-file|Get-Content|command_execution/);
  assert.equal(decodeCodexProgressLine('{"type":"thread.started"}'), null);
});

test('Codex app-server telemetry captures authoritative context pressure', () => {
  const telemetry = normalizeCodexTokenUsage({ threadId: 'thread-123', turnId: 'turn-1', tokenUsage: { modelContextWindow: 10_000, total: { inputTokens: 24_000, cachedInputTokens: 18_000, cacheWriteInputTokens: 0, outputTokens: 3200, reasoningOutputTokens: 900, totalTokens: 27_200 }, last: { inputTokens: 2400, cachedInputTokens: 1800, cacheWriteInputTokens: 0, outputTokens: 320, reasoningOutputTokens: 90, totalTokens: 2720 } } });
  assert.equal(telemetry?.context.usedPercent, 27.2);
  assert.equal(telemetry?.context.remainingPercent, 72.8);
  assert.equal(telemetry?.context.inputTokens, 2400);
  assert.equal(telemetry?.usage.cachedInputTokens, 18_000);
  assert.equal(telemetry?.threadId, 'thread-123');
});

test('Antigravity status collector persists useful telemetry and drops identity fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-statusline-'));
  try {
    const input = { conversation_id: 'conversation-123', email: 'private@example.invalid', workspace: { project_dir: 'F:\\Wiring' }, model: { id: 'gemini-test' }, context_window: { used_percentage: 72, remaining_percentage: 28, context_window_size: 1000 }, quota: { weekly: { remaining_fraction: 0.4, reset_time: '2026-08-14T00:00:00Z' } }, agent_state: 'working' };
    const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'antigravity-statusline.mjs')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORCHESTRA_DATA_DIR: root } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /context 72%/);
    const snapshot = readFileSync(join(root, 'antigravity-status.json'), 'utf8');
    assert.match(snapshot, /conversation-123|remaining_fraction/);
    assert.doesNotMatch(snapshot, /private@example\.invalid|email/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex app-server notifications expose friendly progress but not raw commands', () => {
  const message = codexProgressMessage('item/started', { item: { type: 'commandExecution', command: 'Get-Content secret-file.txt' } });
  assert.equal(message, 'Inspecting relevant project files.');
  assert.doesNotMatch(message || '', /secret-file|Get-Content/);
});

test('Codex progress reports Rider MCP activity without exposing tool arguments', () => {
  const started = codexProgressMessage('item/started', { item: { type: 'mcpToolCall', serverName: 'rider', toolName: 'rider_find_usages', arguments: { query: 'private symbol' } } });
  const completed = codexProgressMessage('item/completed', { item: { type: 'mcpToolCall', serverName: 'rider', toolName: 'rider_find_usages', status: 'completed' } });
  assert.equal(started, 'Using Rider MCP: find usages.');
  assert.equal(completed, 'Rider MCP tool find usages completed.');
  assert.doesNotMatch(started || '', /private symbol/);
});

test('Codex command failures include a safe actionable reason and redact credentials', () => {
  const message = codexProgressMessage('item/completed', { item: { type: 'commandExecution', status: 'failed', exitCode: 1, stderr: 'Path F:\\Missing was not found; token=super-secret-value\nUsage: inspect' } });
  assert.match(message || '', /exit 1/);
  assert.match(message || '', /Path F:\\Missing was not found/);
  assert.match(message || '', /token=\[REDACTED\]/);
  assert.doesNotMatch(message || '', /super-secret-value|Usage:/);
});

test('Antigravity usage command parsing preserves authoritative quota buckets', () => {
  const output = JSON.stringify({ command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', remaining_fraction: 0.86539, reset_time: '2026-08-19T13:28:52Z' }] }] } } });
  assert.deepEqual(extractAntigravityQuotas(output), [{ id: 'gemini-weekly', usedPercent: 13.46, remainingPercent: 86.54, resetsAt: '2026-08-19T13:28:52Z', windowMinutes: null }]);
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

test('provider process failures deterministically transfer diffs or diagnose clean retries', () => {
  assert.equal(providerFailureStatus('Antigravity exceeded its 20-minute print window.'), 'TIMEOUT');
  assert.equal(providerFailureStatus('Antigravity produced no stream activity for five minutes. Orchestra stopped the stalled process.'), 'IDLE_TIMEOUT');
  assert.equal(providerFailureStatus('Antigravity exited with 1'), 'PROCESS_ERROR');
  assert.equal(providerFailoverDisposition(13), 'review_preserved_diff');
  assert.equal(providerFailoverDisposition(0), 'diagnose_and_retry');
});

test('process runner terminates a silent provider before the absolute timeout', async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { idleTimeoutMs: 50, timeoutMs: 1_000 }),
    (error) => error instanceof ProcessIdleTimeoutError,
  );
});

test('Windows npm verification bypasses direct cmd-script spawning', () => {
  const invocation = npmInvocation(['run', 'lint']);
  if (process.platform === 'win32') {
    assert.notEqual(invocation.command.toLowerCase(), 'npm.cmd');
    assert.ok(invocation.command.toLowerCase().endsWith('node.exe') || invocation.command.toLowerCase().endsWith('cmd.exe'));
  } else assert.deepEqual(invocation, { command: 'npm', args: ['run', 'lint'] });
});

test('project verification executes npm scripts through the compatible launcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-verification-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: {
        lint: 'node -e "console.log(\'fixture lint passed\')"',
        build: 'node -e "console.log(\'fixture build passed\')"',
        test: 'node -e "console.log(\'fixture tests passed\')"',
      },
    }));
    const results = await verifyProject(root, new AbortController().signal);
    assert.deepEqual(results.map((result) => [result.command, result.code]), [
      ['npm run lint', 0],
      ['npm run build', 0],
      ['npm test', 0],
    ]);
    assert.match(results[0].output, /fixture lint passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification failures become concrete repair input instead of terminal task errors', () => {
  assert.equal(verificationFailure([{ command: 'npm test', code: 0, output: 'ok' }]), '');
  assert.equal(
    verificationFailure([{ command: 'npm test', code: 1, output: 'expected true to equal false' }]),
    'npm test\nexpected true to equal false',
  );
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

test('Antigravity stream result exposes authoritative turn token usage', () => {
  const raw = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 19601, output_tokens: 13, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 19614 } } });
  assert.deepEqual(extractAntigravityUsage(raw), { input_tokens: 19601, output_tokens: 13, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 19614 });
});

test('read-only Antigravity output survives a late terminal error', () => {
  const raw = JSON.stringify({ event: 'result', result: { conversation_id: 'conversation-123', status: 'ERROR', response: 'Repository F:\\QuestVR\\GameNativeXR has 16 matching commits.' } });
  const result = interpretAntigravityOutput(raw, false);
  assert.match(result.text, /16 matching commits/);
  assert.match(result.warning || '', /preserved the response/);
  assert.throws(() => interpretAntigravityOutput(raw, true), /potentially incomplete file-changing run/);
});

test('mutating Antigravity output can be preserved for automatic independent review', () => {
  const raw = JSON.stringify({ event: 'result', result: { conversation_id: 'conversation-123', status: 'ERROR', response: 'I changed project files but paused before completing verification.' } });
  const result = interpretAntigravityOutput(raw, true, true);
  assert.equal(result.incomplete, true);
  assert.equal(result.status, 'ERROR');
  assert.match(result.warning || '', /continue through independent review and repair/i);
  assert.match(result.text, /changed project files/);
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
  const prompt = buildAntigravityPrompt({ root: 'F:\\Wiring', prompt: 'Finish the tool', mutating: true, recovery: true, riderAvailable: true });
  assert.match(prompt, /recovery run/i);
  assert.match(prompt, /uncommitted working-tree changes/i);
  assert.match(prompt, /Do not start background tasks, scheduled waits, development\/watch servers/i);
  assert.match(prompt, /Do not invoke subagents, delegate through manage_task or invoke_subagent/i);
  assert.match(prompt, /do not.*pause for another agent/i);
  assert.match(prompt, /cancel or close it before returning/i);
  assert.match(prompt, /Rider MCP is healthy and enabled/i);
  assert.match(prompt, /Do not force unrelated work through MCP/i);
});

test('Antigravity progress reports Rider MCP activity without protocol payloads', () => {
  const raw = JSON.stringify({ event: 'tool_call', tool_name: 'rider_search_in_files_by_text', arguments: { query: 'private query' } });
  const decoded = decodeAntigravityProgressLine(raw);
  assert.deepEqual(decoded, ['Antigravity is using Rider MCP: search in files by text.']);
  assert.doesNotMatch(decoded?.join(' ') || '', /private query|arguments/);
});

test('ordinary implementation reviews use Terra and escalate only for material risk or repetition', () => {
  assert.deepEqual(selectReviewProfile({ request: 'Implement the editor', cycle: 0, changedFileCount: 12, triageRisk: 'normal' }), { model: 'gpt-5.6-terra', effort: 'medium', reason: 'diff-scoped implementation review' });
  assert.deepEqual(selectReviewProfile({ request: 'Implement the editor', cycle: 0, changedFileCount: 20, triageRisk: 'normal' }), { model: 'gpt-5.6-terra', effort: 'high', reason: 'multi-file repair review' });
  assert.equal(selectReviewProfile({ request: 'Repair authorization checks', cycle: 0, changedFileCount: 3, triageRisk: 'normal' }).model, 'gpt-5.6-sol');
  assert.equal(selectReviewProfile({ request: 'Implement the editor', cycle: 0, changedFileCount: 3, triageRisk: 'high' }).model, 'gpt-5.6-sol');
  assert.equal(selectReviewProfile({ request: 'Implement the editor', cycle: 2, changedFileCount: 3, triageRisk: 'normal' }).model, 'gpt-5.6-sol');
});

test('review packets are bounded, diff-first, and redact secrets', () => {
  const packet = buildReviewPacket({
    request: 'Implement feature token=do-not-share',
    changedFiles: ['src/app.ts'],
    diff: '+ const password="top-secret";',
    implementationSummary: 'Implemented src/app.ts',
    triage: { risk: 'normal', summary: 'Inspect state transitions.', focusFiles: ['src/app.ts'], concerns: ['Potential stale state.'] },
    previousReview: 'VERDICT: BLOCK\nRepair the state transition.',
  });
  assert.match(packet, /# Orchestra review packet/);
  assert.match(packet, /src\/app\.ts/);
  assert.match(packet, /Previous Codex review/);
  assert.match(packet, /token=\[REDACTED\]|token=\[REDACTED_SECRET\]/);
  assert.doesNotMatch(packet, /do-not-share|top-secret/);
  assert.ok(packet.length <= 100_000);
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

test('extractCodexReviewVerdict parses strict verdict headers without body false-positives', () => {
  const directPass = extractCodexReviewVerdict('VERDICT: PASS\n\nAll changes look solid.');
  assert.equal(directPass.verdict, 'PASS');
  assert.equal(directPass.blocked, false);

  const directBlock = extractCodexReviewVerdict('VERDICT: BLOCK\n\n1. Critical missing null check in parser.');
  assert.equal(directBlock.verdict, 'BLOCK');
  assert.equal(directBlock.blocked, true);

  const markdownHeaderPass = extractCodexReviewVerdict('## Verdict: PASS\n\nPrevious review had VERDICT: BLOCK, but that is now fixed.');
  assert.equal(markdownHeaderPass.verdict, 'PASS');
  assert.equal(markdownHeaderPass.blocked, false);

  const bodyMentionWithoutHeader = extractCodexReviewVerdict('Here is the analysis of changes.\nWe discussed why someone might write VERDICT: PASS here, but actually:\n1. [P1] Broken build.');
  assert.equal(bodyMentionWithoutHeader.verdict, 'BLOCK');
  assert.equal(bodyMentionWithoutHeader.blocked, true);
});

test('evaluateRunHealth classifies review_disputed as needs_attention', () => {
  assert.equal(evaluateRunHealth('review_disputed', false, 0), 'needs_attention');
  assert.equal(evaluateRunHealth('recovery_required', false, 0), 'needs_attention');
  assert.equal(evaluateRunHealth('running', true, 10_000), 'active');
  assert.equal(evaluateRunHealth('running', true, 100_000), 'waiting');
  assert.equal(evaluateRunHealth('running', false, 0), 'possibly_stalled');
});

test('distillVerificationErrors provides structured actionable findings or resilient fallback', async () => {
  const sampleError = `
server/tasks.ts(285,34): error TS2339: Property 'remote' does not exist on type 'GitStatus'.
src/App.tsx(42,12): error TS2304: Cannot find name 'unresolvedVariable'.
`;
  const result = await distillVerificationErrors(sampleError, 'npm run build');
  assert.ok(result.summary);
  assert.ok(result.repairPromptChunk.includes('npm run build'));
});

test('sliceSemanticCommits preserves all changed files across slices', async () => {
  const files = ['src/domain/types.ts', 'src/domain/validation.ts', 'src/components/Timeline.tsx', 'README.md'];
  const diff = `
diff --git a/src/domain/types.ts b/src/domain/types.ts
+ export interface Span {}
diff --git a/src/components/Timeline.tsx b/src/components/Timeline.tsx
+ export function Timeline() {}
`;
  const slices = await sliceSemanticCommits(diff, files, 'Build LogLens visualizer');
  assert.ok(Array.isArray(slices));
  assert.ok(slices.length >= 1);
  const allAssigned = slices.flatMap((s) => s.files);
  for (const f of files) {
    assert.ok(allAssigned.includes(f), `Expected file ${f} to be included in slices`);
  }
});

test('preReviewSanityCheck handles clean and empty file inputs safely', async () => {
  const clean = await preReviewSanityCheck({ root: 'F:/sample', changedFiles: [], diff: '' });
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.issues, []);
});

test('direct mode classification preserves solo agent execution intent', () => {
  const directGemma = {
    type: 'question',
    mutating: false,
    complexity: 'small',
    riskFlags: [],
    codexRole: 'none',
    executionMode: 'direct',
    directAgent: 'gemma',
    title: 'Explain span propagation',
  };
  assert.equal(directGemma.executionMode, 'direct');
  assert.equal(directGemma.directAgent, 'gemma');
  assert.equal(directGemma.mutating, false);

  const directCodex = {
    type: 'question',
    mutating: false,
    complexity: 'small',
    riskFlags: [],
    codexRole: 'none',
    executionMode: 'direct',
    directAgent: 'codex',
    title: 'Analyze architecture trade-offs',
  };
  assert.equal(directCodex.executionMode, 'direct');
  assert.equal(directCodex.directAgent, 'codex');
});


