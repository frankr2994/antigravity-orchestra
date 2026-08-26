import { ProcessIdleTimeoutError, ProcessTimeoutError, runProcess } from '../../process.js';
import { attachTrustedLocalArtifacts } from '../../application/context/agent-prompt-context.js';

const AGY = process.platform === 'win32' ? 'agy.exe' : 'agy';
export interface AgentRunResult { text: string; conversationId: string | null; raw: string; warning: string | null; usage: Record<string, number> | null; terminalStatus: string | null; incomplete: boolean; failureReason: string | null; continuationGuidance: string | null; }
interface StreamDecoder { push: (chunk: string) => void; flush: () => void; sandboxFailed: () => boolean; }

export async function listAntigravityModels(): Promise<string[]> {
  try {
    const result = await runProcess(AGY, ['models'], { timeoutMs: 15_000 });
    return result.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter((line) => /^(gemini|claude|gpt)/.test(line));
  } catch { return []; }
}

export async function runAntigravity(input: { root: string; prompt: string; model: string; effort: string; mutating: boolean; conversationId: string | null; context?: string; recovery?: boolean; riderAvailable?: boolean; signal: AbortSignal; onOutput: (chunk: string) => void; onUsage?: (value: unknown) => void }): Promise<AgentRunResult> {
  const prompt = buildAntigravityPrompt(input);
  const args = buildAntigravityArgs({ ...input, prompt });
  const startedAt = Date.now();
  let lastVisibleAt = startedAt;
  const visibleOutput = (chunk: string) => { lastVisibleAt = Date.now(); input.onOutput(chunk); };
  const decoder = createAntigravityStreamDecoder(visibleOutput);
  const progressTimer = setInterval(() => {
    if (Date.now() - lastVisibleAt < 60_000) return;
    const elapsedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
    visibleOutput(`Antigravity is still working in the foreground (${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'} elapsed).`);
  }, 15_000);
  let result;
  try {
    result = await runProcess(AGY, args, { cwd: input.root, timeoutMs: 21 * 60_000, idleTimeoutMs: 5 * 60_000, signal: input.signal, onStdout: decoder.push, onStderr: decoder.push });
  } catch (error) {
    decoder.flush();
    if (error instanceof ProcessIdleTimeoutError) {
      throw new Error('Antigravity produced no stream activity for five minutes. Orchestra stopped the stalled process so another model can diagnose and continue the task.');
    }
    if (error instanceof ProcessTimeoutError) {
      throw new Error('Antigravity exceeded its 20-minute print window. Orchestra stopped the process and preserved any uncommitted task changes for safe recovery.');
    }
    throw error;
  } finally {
    clearInterval(progressTimer);
  }
  decoder.flush();
  if (result.code !== 0) throw new Error(result.stderr || `Antigravity exited with ${result.code}`);
  const terminal = interpretAntigravityOutput(result.stdout, input.mutating, input.mutating);
  const usage = extractAntigravityUsage(result.stdout);
  input.onUsage?.({ conversationId: terminal.conversationId, usage });
  if (!input.mutating && !responseIdentifiesProject(terminal.text, input.root)) {
    throw new Error(`Antigravity's response did not identify the active project directory (${input.root}), so Orchestra rejected it to prevent cross-repository output. Start a new conversation and retry.`);
  }
  return { text: terminal.text, conversationId: terminal.conversationId, raw: result.stdout, warning: terminal.warning, usage, terminalStatus: terminal.status, incomplete: terminal.incomplete, failureReason: terminal.incomplete ? terminal.warning : null, continuationGuidance: null };
}

export function extractAntigravityUsage(output: string) {
  let usage: Record<string, number> | null = null;
  for (const line of output.split(/\r?\n/)) try {
    const value = JSON.parse(line) as Record<string, any>;
    const candidate = value.event === 'result' ? value.result?.usage : value.step_update?.usage;
    if (candidate && typeof candidate === 'object') usage = Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, Number(item) || 0]));
  } catch { /* Ignore incomplete diagnostics. */ }
  return usage;
}

export function buildAntigravityPrompt(input: { root: string; prompt: string; mutating: boolean; context?: string; recovery?: boolean; riderAvailable?: boolean }) {
  const action = input.mutating
    ? 'Implement and verify the request. Do not commit or push; the dashboard owns Git finalization.'
    : 'Answer the request using read-only inspection. Do not modify files.';
  const recovery = input.recovery
    ? 'This is a recovery run. The uncommitted working-tree changes were created by the prior failed attempt at this same request. Inspect and preserve useful partial work, finish missing pieces, correct defects, and verify the complete result.'
    : '';
  const rider = input.riderAvailable ? 'JetBrains Rider MCP is healthy and enabled for this turn. Prefer Rider for solution-aware navigation, symbol searches and usages, project dependencies, IDE diagnostics, safe refactors, and targeted file operations when its semantic context is better than raw shell inspection. Use Git and ordinary shell tools where they are more appropriate; do not force unrelated work through MCP.\n\n' : '';
  const request = attachTrustedLocalArtifacts(input.prompt);
  return `${input.context ? `A read-only Codex specialist provided this analysis:\n\n${input.context}\n\n` : ''}Authoritative active project directory: ${input.root}\n\nThis exact directory is the repository for the task. Start every repository inspection in this directory and keep all file access inside it. Do not search other drives or choose another repository based on similarly named AGENTS.md files. Treat AGENTS.md as workflow instructions, not as the repository's identity.\n\n${rider}${recovery ? `${recovery}\n\n` : ''}User request:\n${request}\n\n${action}\n\nExecution requirements: perform the work directly in this foreground turn. Respect explicit phase boundaries and gates: when the request authorizes or begins one named phase, complete and verify only that phase; do not prebuild later phases. Do not invoke subagents, delegate through manage_task or invoke_subagent, or pause for another agent. Do not start background tasks, scheduled waits, development/watch servers, or any command that remains active. Run verification commands synchronously to completion. If a tool unexpectedly creates background work, wait for it directly and cancel or close it before returning. End with a concise result and the verification performed. In the final response, explicitly identify the repository using the authoritative directory above.`;
}

export function interpretAntigravityOutput(output: string, mutating: boolean, preserveIncompleteMutation = false) {
  const terminal = extractAntigravityTerminalResult(output);
  if (!terminal.text) {
    if (terminal.status && terminal.status !== 'SUCCESS') throw new Error(`Antigravity finished with status ${terminal.status} without a final response.`);
    throw new Error('Antigravity exited successfully but its structured result did not contain a response. Check the Antigravity CLI log and retry.');
  }
  if (terminal.status && terminal.status !== 'SUCCESS') {
    if (mutating && !preserveIncompleteMutation) throw new Error(`Antigravity produced output but finished with status ${terminal.status}; Orchestra will not accept a potentially incomplete file-changing run.`);
    if (mutating) return { ...terminal, incomplete: true, warning: `Antigravity ended with status ${terminal.status} during a file-changing task. Orchestra will not accept its response as completion; the working tree will be inspected and any preserved changes will continue through independent review and repair.` };
    return { ...terminal, incomplete: false, warning: `Antigravity reported terminal status ${terminal.status} after producing a final read-only response. Orchestra preserved the response.` };
  }
  return { ...terminal, incomplete: false, warning: null };
}

export function buildAntigravityArgs(input: { prompt: string; model: string; effort: string; mutating: boolean; conversationId: string | null }) {
  const args = ['--output-format', 'stream-json', '--model', input.model, '--effort', input.effort, '--mode', 'accept-edits', '--print-timeout', '20m'];
  if (!input.mutating) args.push('--sandbox');
  if (input.conversationId) args.push('--conversation', input.conversationId);
  // --print and --prompt both take a prompt value. A bare --print would consume
  // the following flag as the user's prompt, so keep this value-taking option last.
  args.push('--prompt', input.prompt);
  return args;
}

export function responseIdentifiesProject(response: string, root: string) {
  const normalize = (value: string) => {
    let decoded = value;
    try { decoded = decodeURI(value); } catch { /* retain malformed text for a safe comparison */ }
    return decoded.replace(/^file:\/+/i, '').replaceAll('\\', '/').replace(/^\/?([A-Za-z]:)/, '$1').replace(/\/$/, '').toLowerCase();
  };
  return normalize(response).includes(normalize(root));
}

export function extractAntigravityText(output: string): string {
  const texts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    try { collectVisibleAgentText(JSON.parse(line), texts); } catch { /* ignore non-protocol diagnostics */ }
  }
  return [...new Set(texts.filter((text) => text.trim().length > 1))].join('\n').trim();
}

function collectVisibleAgentText(value: unknown, output: string[], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return;
  if (Array.isArray(value)) { for (const item of value) collectVisibleAgentText(item, output, depth + 1); return; }
  const record = value as Record<string, unknown>;
  const type = String(record.event || record.type || record.role || '').toLowerCase();
  if (type === 'result' && record.result && typeof record.result === 'object') {
    const result = record.result as Record<string, unknown>;
    if (typeof result.response === 'string') output.push(result.response);
  }
  if (['assistant', 'agent_message', 'final', 'final_output', 'result'].includes(type)) {
    for (const key of ['response', 'text', 'content', 'message', 'output_text']) if (typeof record[key] === 'string') output.push(String(record[key]));
  }
  for (const child of Object.values(record)) if (child && typeof child === 'object') collectVisibleAgentText(child, output, depth + 1);
}

function extractAntigravityTerminalResult(output: string): { text: string; conversationId: string | null; status: string | null } {
  let conversationId: string | null = null;
  let status: string | null = null;
  const texts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      collectVisibleAgentText(value, texts);
      const result = value.event === 'result' && value.result && typeof value.result === 'object'
        ? value.result as Record<string, unknown>
        : value;
      const id = result.conversation_id || result.conversationId || result.session_id;
      if (typeof id === 'string' && id) conversationId = id;
      if (value.event === 'result' && typeof result.status === 'string') status = result.status.toUpperCase();
    } catch { /* ignore */ }
  }
  return { text: [...new Set(texts.filter((text) => text.trim().length > 1))].join('\n').trim(), conversationId, status };
}

function createAntigravityStreamDecoder(onOutput: (text: string) => void): StreamDecoder {
  let buffer = ''; const seen = new Set<string>();
  const handle = (line: string) => {
    const decoded = decodeAntigravityProgressLine(line);
    if (!decoded) return;
    for (const message of decoded) if (!seen.has(message)) { seen.add(message); onOutput(message); }
  };
  return lineDecoder(handle, () => false, (chunk) => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) handle(line); }, () => { if (buffer) handle(buffer); buffer = ''; });
}

export function decodeAntigravityProgressLine(line: string): string[] | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const messages: string[] = [];
    collectVisibleAgentText(value, messages);
    const event = String(value.event || value.type || '');
    const mcp = antigravityMcpActivity(value);
    if (mcp) messages.push(mcp);
    if (/step_update/i.test(event)) {
      const step = value.step && typeof value.step === 'object' ? value.step as Record<string, unknown> : value;
      const stepType = String(step.step_type || step.type || '');
      if (/tool|command/i.test(stepType) && !messages.length) messages.push('Antigravity is inspecting or updating the project.');
    }
    return messages.length ? messages : null;
  } catch { return null; }
}

function antigravityMcpActivity(value: Record<string, unknown>) {
  const serialized = JSON.stringify(value);
  const event = String(value.event || value.type || '').toLowerCase();
  if (!/rider/i.test(serialized) || !/(?:mcp|tool)/i.test(serialized)) return null;
  const record = (value.step && typeof value.step === 'object' ? value.step : value) as Record<string, unknown>;
  const rawName = String(record.tool_name || record.toolName || record.name || record.command?.toString() || '');
  const name = rawName.match(/rider[_:./-]*([A-Za-z0-9_-]+)/i)?.[1]?.replace(/[_-]+/g, ' ').slice(0, 80);
  if (/error|failed/i.test(event)) return `A Rider MCP${name ? ` tool ${name}` : ''} call failed; Antigravity is continuing with another tool.`;
  if (/result|completed|finished/i.test(event)) return `Rider MCP${name ? ` tool ${name}` : ''} completed for Antigravity.`;
  return `Antigravity is using Rider MCP${name ? `: ${name}` : ''}.`;
}

function lineDecoder(_handle: (line: string) => void, sandboxFailed: () => boolean, push: (chunk: string) => void, flush: () => void): StreamDecoder { return { push, flush, sandboxFailed }; }
