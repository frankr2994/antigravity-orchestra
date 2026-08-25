import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runGemmaDirectChat } from '../dist-server/agents.js';
import {
  formatDirectGitStatusAnswer,
  isDirectGitStatusQuestion,
  validateGemmaDirectChatResponse,
} from '../dist-server/application/gemma/direct-chat-contract.js';
import { Store } from '../dist-server/db.js';
import { TaskManager } from '../dist-server/tasks.js';

function streamResponse(payloads) {
  const body = payloads.map((payload) => payload === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(payload)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(message, finishReason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function git(cwd, args) {
  const result = spawnSync('git.exe', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initializeRepository(projectRoot) {
  mkdirSync(projectRoot, { recursive: true });
  git(projectRoot, ['init', '-b', 'main']);
  git(projectRoot, ['config', 'user.name', 'Tester']);
  git(projectRoot, ['config', 'user.email', 'tester@example.com']);
  writeFileSync(join(projectRoot, 'app.ts'), 'export const value = 1;\n');
  git(projectRoot, ['add', 'app.ts']);
  git(projectRoot, ['commit', '-m', 'baseline']);
}

async function waitForTerminalTask(store, taskId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = store.getTask(taskId);
    if (task && ['completed', 'completed_unpushed', 'failed', 'cancelled', 'recovery_required'].includes(task.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state.`);
}

test('Gemma direct-chat contract preserves ordinary Markdown and identifies Git-status questions', () => {
  const markdown = 'Use `git status --short` when you want a compact report.\n\n- This is ordinary explanatory Markdown.';
  assert.equal(validateGemmaDirectChatResponse(markdown), markdown);
  assert.equal(isDirectGitStatusQuestion('are there any uncommited changes to this project?'), true);
  assert.equal(isDirectGitStatusQuestion('git status --short'), true);
  assert.equal(isDirectGitStatusQuestion('implement a Git status panel'), false);
  assert.match(formatDirectGitStatusAnswer('F:\\project', { isGit: true, root: 'F:\\project', branch: 'main', head: 'abc', upstream: null, files: [], dirty: false }), /working tree is clean/i);
});

test('Gemma Solo buffers streamed Markdown until it passes the response contract', async () => {
  const requests = [];
  const output = [];
  const answer = await runGemmaDirectChat({
    root: 'F:\\project',
    prompt: 'Explain the architecture.',
    model: 'test-model',
    fetchFn: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return streamResponse([
        { choices: [{ delta: { content: 'The project uses ' } }] },
        { choices: [{ delta: { content: '**modular services**.' }, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    },
    onOutput: (chunk) => output.push(chunk),
  });

  assert.equal(answer, 'The project uses **modular services**.');
  assert.deepEqual(output, [answer], 'only the validated final answer becomes visible');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, true);
  assert.equal(Object.hasOwn(requests[0], 'tools'), false, 'Solo mode declares no executable tools');
});

test('Gemma Solo suppresses raw tool syntax and accepts one ordinary no-tool repair response', async () => {
  const requests = [];
  const output = [];
  const fetchFn = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.stream) {
      return streamResponse([
        { choices: [{ delta: { content: '<|tool_call>call:Bash{command:' } }] },
        { choices: [{ delta: { content: 'git status --short}' }, finish_reason: 'stop' }] },
        '[DONE]',
      ]);
    }
    return jsonResponse({ content: 'I cannot run shell commands in Solo mode. The supplied evidence must be used instead.' });
  };

  const answer = await runGemmaDirectChat({
    root: 'F:\\project',
    prompt: 'What changed?',
    model: 'agentic-model',
    fetchFn,
    onOutput: (chunk) => output.push(chunk),
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].stream, false);
  assert.doesNotMatch(answer, /tool_call|call:Bash/);
  assert.deepEqual(output, [answer], 'the rejected first response is never emitted');
});

test('Gemma Solo rejects repeated structured tool calls without displaying or executing them', async () => {
  const output = [];
  let requestCount = 0;
  const fetchFn = async (_url, options) => {
    requestCount += 1;
    const request = JSON.parse(options.body);
    if (request.stream) {
      return streamResponse([{ choices: [{ delta: { tool_calls: [{ id: 'one', function: { name: 'Bash', arguments: '{"command":"git status"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']);
    }
    return jsonResponse({ content: null, tool_calls: [{ id: 'two', function: { name: 'Bash', arguments: '{"command":"git status"}' } }] }, 'tool_calls');
  };

  await assert.rejects(
    runGemmaDirectChat({ root: 'F:\\project', prompt: 'Inspect it.', model: 'agentic-model', fetchFn, onOutput: (chunk) => output.push(chunk) }),
    (error) => error?.code === 'GEMMA_UNSUPPORTED_TOOL_OUTPUT' && /No command was executed/.test(error.message),
  );
  assert.equal(requestCount, 2);
  assert.deepEqual(output, []);
});

test('Gemma Solo answers Git status from the real repository without model-generated protocol', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-gemma-status-'));
  const projectRoot = join(root, 'project');
  const store = new Store(join(root, 'orchestra.db'));
  try {
    initializeRepository(projectRoot);
    writeFileSync(join(projectRoot, 'app.ts'), 'export const value = 2;\n');
    writeFileSync(join(projectRoot, 'notes.txt'), 'new file\n');
    const project = store.upsertProject({ name: 'Git status fixture', root: projectRoot, gitRoot: projectRoot });
    const session = store.createSession(project.id, 'Gemma status');
    const classification = {
      type: 'question', mutating: false, complexity: 'small', riskFlags: [], codexRole: 'none', localOperation: 'none',
      executionMode: 'direct', directAgent: 'gemma', directModel: 'agentic-model', directEffort: 'high', title: 'Check Git status',
    };
    const task = store.createTask(project.id, session.id, 'are there any uncommited changes to this project?', JSON.stringify(classification));
    const manager = new TaskManager(store, 1);
    manager.enqueue(task.id);

    const finished = await waitForTerminalTask(store, task.id);
    assert.equal(finished.state, 'completed');
    assert.match(finished.result, /2 uncommitted files/i);
    assert.match(finished.result, /`app\.ts`/);
    assert.match(finished.result, /`notes\.txt`/);
    assert.doesNotMatch(finished.result, /tool_call|call:Bash/);
    const assistant = store.listMessages(session.id).find((message) => message.role === 'assistant');
    assert.equal(assistant.agent, 'system', 'deterministic Git evidence retains truthful provenance');
    assert.equal(assistant.content, finished.result);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
