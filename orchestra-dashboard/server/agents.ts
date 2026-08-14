import { config } from './config.js';
import { ProcessTimeoutError, runProcess } from './process.js';
import type { ChatMessage, ModelSelection, TaskClassification, TaskRecord } from './types.js';
import type { RepositoryEvidence } from './evidence.js';
import { delimiter } from 'node:path';
import { codexAppServer } from './codex-app-server.js';
import { callGemmaRiderTool, getGemmaRiderTools } from './mcp.js';

const AGY = process.platform === 'win32' ? 'agy.exe' : 'agy';

export interface AgentRunResult { text: string; conversationId: string | null; raw: string; warning: string | null; usage: Record<string, number> | null; }
interface StreamDecoder { push: (chunk: string) => void; flush: () => void; sandboxFailed: () => boolean; }
type JsonSchema = { name: string; schema: Record<string, unknown> };

const CLASSIFICATION_SCHEMA: JsonSchema = { name: 'task_classification', schema: { type: 'object', properties: { type: { type: 'string', enum: ['question', 'implementation', 'debug', 'design', 'review', 'test'] }, mutating: { type: 'boolean' }, complexity: { type: 'string', enum: ['small', 'normal', 'deep'] }, riskFlags: { type: 'array', items: { type: 'string' } }, codexRole: { type: 'string', enum: ['none', 'design', 'debug', 'review'] }, localOperation: { type: 'string', enum: ['none', 'connect_git_remote'] }, title: { type: 'string' } }, required: ['type', 'mutating', 'complexity', 'riskFlags', 'codexRole', 'localOperation', 'title'], additionalProperties: false } };
const REPOSITORY_ANSWER_SCHEMA: JsonSchema = { name: 'repository_answer', schema: { type: 'object', properties: { canAnswer: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, answer: { type: 'string' }, evidenceFiles: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } } }, required: ['canAnswer', 'confidence', 'answer', 'evidenceFiles', 'limitations'], additionalProperties: false } };
const POSTFLIGHT_SCHEMA: JsonSchema = { name: 'repository_postflight', schema: { type: 'object', properties: { status: { type: 'string', enum: ['pass', 'warn', 'block'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'confidence', 'issues'], additionalProperties: false } };
const CHANGE_SUMMARY_SCHEMA: JsonSchema = { name: 'change_summary', schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'], additionalProperties: false } };
const RUN_HEALTH_SCHEMA: JsonSchema = { name: 'run_health', schema: { type: 'object', properties: { explanation: { type: 'string' } }, required: ['explanation'], additionalProperties: false } };

export async function lmStudioHealth() {
  try {
    const response = await fetch(`${config.lmStudioBaseUrl}/models`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: string }> };
    const models = body.data?.map((item) => item.id).filter(Boolean) || [];
    return { available: true, modelAvailable: models.includes(config.lmStudioModel), models };
  } catch (error) {
    return { available: false, modelAvailable: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function explainRunHealth(snapshot: Record<string, unknown>) {
  const raw = await callGemma([
    { role: 'system', content: 'Explain one Orchestra run-health snapshot in 2-4 plain sentences. State what is happening, whether it appears healthy, and why it would need user attention. Do not recommend stopping an active run and do not invent details beyond the snapshot. Return JSON only.' },
    { role: 'user', content: JSON.stringify(snapshot) },
  ], 300, 30_000, RUN_HEALTH_SCHEMA);
  const value = parseJson(raw) as Record<string, unknown>;
  return String(value.explanation || '').trim() || 'Gemma could not add an explanation to the deterministic monitor status.';
}

export async function answerRunQuestion(question: string, evidence: Record<string, unknown>) {
  const raw = await callGemma([
    { role: 'system', content: `You are Orchestra's local run analyst. Answer the user's question from the supplied deterministic evidence only. Explain concrete review findings, failed commands, repair progress, agent activity, context pressure, or quota pressure when present. Clearly distinguish observed facts from likely interpretation. If the evidence does not establish an answer, say exactly what is missing. Never claim access to hidden reasoning. Keep the answer concise but specific.` },
    { role: 'user', content: `Question:\n${question}\n\nSanitized run evidence:\n${redactSecrets(JSON.stringify(evidence)).slice(-100_000)}` },
  ], 1_200, 90_000);
  return raw.trim();
}

async function callGemma(messages: Array<Record<string, unknown>>, maxTokens = 700, timeoutMs = 60_000, jsonSchema?: JsonSchema, riderTools = false): Promise<string> {
  const conversation = [...messages];
  const tools = riderTools ? await getGemmaRiderTools() : [];
  let toolCallsUsed = 0;
  for (let round = 0; round < 5; round += 1) {
    const response = await fetch(`${config.lmStudioBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.lmStudioModel, messages: conversation, temperature: 0.2, max_tokens: maxTokens, ...(jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema } } } : {}), ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> };
    const message = body.choices?.[0]?.message;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (calls.length) {
      conversation.push({ role: 'assistant', content: message?.content || null, tool_calls: calls });
      for (const call of calls) {
        toolCallsUsed += 1;
        if (toolCallsUsed > 6) throw new Error('Gemma exceeded the bounded Rider MCP tool-call limit.');
        const name = String(call.function?.name || '');
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(String(call.function?.arguments || '{}')) as Record<string, unknown>; } catch { /* The tool receives an empty object and returns a useful schema error. */ }
        let content: string;
        try { content = await callGemmaRiderTool(name, args); }
        catch (error) { content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
        conversation.push({ role: 'tool', tool_call_id: String(call.id || `rider-${toolCallsUsed}`), name, content });
      }
      continue;
    }
    const content = message?.content?.trim();
    if (!content) throw new Error('LM Studio returned an empty response');
    return content;
  }
  throw new Error('Gemma did not finish after the bounded Rider MCP tool loop.');
}

export interface GemmaRepositoryAnswer {
  canAnswer: boolean;
  confidence: number;
  answer: string;
  evidenceFiles: string[];
  limitations: string[];
  rejectionReasons: string[];
  attempts: number;
}

export interface GemmaPostflight {
  status: 'pass' | 'warn' | 'block';
  confidence: number;
  issues: string[];
}

export function shouldAttemptGemmaAnswer(classification: TaskClassification, prompt: string) {
  if (classification.type !== 'question' || classification.mutating || classification.complexity !== 'small' || classification.codexRole !== 'none' || classification.riskFlags.length) return false;
  return !/\b(latest|current news|internet|online search|browse|download|install|run|execute|launch|compile|benchmark|deploy|device|adb|screenshot|open the app|commits?|git log|git history|revision history|authors?|who changed)\b/i.test(prompt);
}

export function normalizeEvidenceFile(value: string, root: string, availableFiles: string[]) {
  let candidate = value.trim().replace(/^`+|`+$/g, '');
  const markdownTarget = candidate.match(/\]\(([^)]+)\)/)?.[1];
  if (markdownTarget) candidate = markdownTarget;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch { /* Leave malformed model output for the normal matcher to reject. */ }
  }
  candidate = candidate.replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:\/)/, '').replace(/[?#].*$/, '');
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (candidate.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) candidate = candidate.slice(normalizedRoot.length + 1);
  candidate = candidate.replace(/^\.\//, '').replace(/^\//, '');
  return availableFiles.find((file) => file.replace(/\\/g, '/').toLowerCase() === candidate.toLowerCase()) || null;
}

export async function answerRepositoryQuestion(input: { root: string; prompt: string; evidence: RepositoryEvidence; sessionContext?: string }): Promise<GemmaRepositoryAnswer> {
  const system = `You are Orchestra's local repository analyst. Answer only from the supplied evidence. Return JSON only with this schema: {"canAnswer":boolean,"confidence":number,"answer":string,"evidenceFiles":string[],"limitations":string[]}.
Rules:
- The authoritative repository is exactly ${input.root}. State that path in the answer.
- Never infer facts from similarly named repositories or general knowledge.
- Distinguish implemented behavior from plans, comments, declarations, and opaque/prebuilt components.
- If evidence is insufficient or the request needs tools/runtime/network access, set canAnswer=false.
- confidence must be between 0 and 1. Use at least 0.86 only when the answer is directly supported.
- The answer must directly address every part of the question. For a repository overview, provide a useful 300-900 word Markdown explanation covering purpose, architecture, important entry points, build/test workflow, current limitations, and evidence paths.
- Put only genuine evidence gaps in limitations; do not move requested answer content there.
- Cite repository-relative evidence paths inline and repeat those exact paths in evidenceFiles. evidenceFiles must refer only to files whose contents appear under "## File:" in the evidence packet.
- Inside JSON strings, write Windows paths with forward slashes (for example F:/project) so backslashes cannot create invalid JSON escapes.
- Finish every section and sentence; never submit a truncated draft.`;
  const user = `${input.sessionContext ? `Session context:\n${input.sessionContext}\n\n` : ''}Question:\n${input.prompt}\n\n${input.evidence.text}`;
  let raw = await callGemma([{ role: 'system', content: `${system}\nA bounded read-only JetBrains Rider MCP toolset may be available. Use it only when it materially improves repository inspection; never claim a tool result you did not receive.` }, { role: 'user', content: user }], 4_000, 180_000, REPOSITORY_ANSWER_SCHEMA, true);
  let result = normalizeRepositoryAnswer(parseJson(raw) as Record<string, unknown>, input, 1);
  if (!result.canAnswer && result.confidence >= 0.86) {
    raw = await callGemma([
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: raw },
      { role: 'user', content: `The draft was rejected for these deterministic reasons: ${result.rejectionReasons.join('; ')}. Return a corrected, complete JSON answer. Use only content-included repository files as evidence and do not end mid-sentence.` },
    ], 4_000, 180_000, REPOSITORY_ANSWER_SCHEMA, true);
    result = normalizeRepositoryAnswer(parseJson(raw) as Record<string, unknown>, input, 2);
  }
  return result;
}

function normalizeRepositoryAnswer(value: Record<string, unknown>, input: { root: string; evidence: RepositoryEvidence }, attempts: number): GemmaRepositoryAnswer {
  const confidence = normalizeConfidence(value.confidence);
  const answer = typeof value.answer === 'string' ? value.answer.trim() : '';
  const suppliedEvidenceFiles = Array.isArray(value.evidenceFiles) ? value.evidenceFiles.map(String) : [];
  const evidenceFiles = [...new Set(suppliedEvidenceFiles.map((path) => normalizeEvidenceFile(path, input.root, input.evidence.includedFiles)).filter((path): path is string => Boolean(path)))].slice(0, 30);
  const limitations = Array.isArray(value.limitations) ? value.limitations.map(String).filter(Boolean).slice(0, 12) : [];
  const rootLabeled = responseIdentifiesProject(answer, input.root) ? answer : `### Repository: ${input.root}\n\n${answer}`;
  const rootedAnswer = limitations.length ? `${rootLabeled}\n\n### Evidence notes\n${limitations.map((item) => `- ${item}`).join('\n')}` : rootLabeled;
  const rejectionReasons: string[] = [];
  if (value.canAnswer !== true) rejectionReasons.push('Gemma reported that the supplied evidence was insufficient');
  if (confidence < 0.86) rejectionReasons.push(`confidence ${confidence.toFixed(2)} was below the 0.86 threshold`);
  if (answer.length <= 80) rejectionReasons.push('the proposed answer was too short to be useful');
  if (/\b(?:the|a|an|and|or|to|of|with|including|such as|based on)\s*$/i.test(answer) || /[:;,(-]\s*$/.test(answer)) rejectionReasons.push('the proposed answer ended mid-sentence');
  if (!evidenceFiles.length) rejectionReasons.push(suppliedEvidenceFiles.length ? 'none of the cited paths referred to files whose contents were included in the evidence packet' : 'the answer cited no repository evidence files');
  return { canAnswer: rejectionReasons.length === 0, confidence, answer: rootedAnswer, evidenceFiles, limitations, rejectionReasons, attempts };
}

function isActionablePostflightIssue(issue: string) {
  if (/\bno\s+(?:material\s+)?(?:unsupported claims?|incorrect claims?|missing files?|errors?|contradictions?)\b/i.test(issue)) return false;
  return /\b(?:incorrect|inaccurate|wrong|absent|missing|unsupported|unverified|contradict(?:s|ion|ory)?|conflict(?:s|ing)?|overstat(?:e|es|ed|ement)|hallucinat(?:e|es|ed|ion)|cannot verify|does not (?:exist|match|identify|distinguish|support)|no evidence (?:for|of)|fails? to|omits?|error)\b/i.test(issue);
}

export function normalizePostflightResult(value: Record<string, unknown>): GemmaPostflight {
  const requestedStatus = String(value.status || '').toLowerCase();
  const issues = (Array.isArray(value.issues) ? value.issues : [])
    .map(String)
    .map((issue) => issue.trim())
    .filter(Boolean)
    .filter(isActionablePostflightIssue)
    .slice(0, 8);
  if (!issues.length) return { status: 'pass', confidence: normalizeConfidence(value.confidence), issues: [] };
  const status = requestedStatus === 'block' ? 'block' : 'warn';
  return { status, confidence: normalizeConfidence(value.confidence), issues };
}

export async function validateAgentResponse(input: { root: string; prompt: string; response: string; evidence: RepositoryEvidence }): Promise<GemmaPostflight> {
  if (!responseIdentifiesProject(input.response, input.root)) {
    return { status: 'block', confidence: 1, issues: [`The response does not identify the authoritative active project directory (${input.root}).`] };
  }
  const system = `You are a conservative local fact checker. Compare a remote agent's repository answer with the supplied evidence. Return JSON only: {"status":"pass|warn|block","confidence":number,"issues":string[]}.
Block only for a concrete high-impact error: wrong repository, claimed files/components absent from inventory, implemented-vs-planned confusion, or a direct contradiction. Warn for a specific factual caveat or overstatement. Every issues entry must describe an error or required correction; never put confirmations, supporting observations, compliments, or summaries in issues. For pass, issues must be empty. Do not block merely because evidence is truncated or because wording differs. The authoritative root is ${input.root}.`;
  const user = `Request:\n${input.prompt}\n\nRemote response:\n${input.response.slice(0, 45_000)}\n\n${input.evidence.text}`;
  const value = parseJson(await callGemma([{ role: 'system', content: system }, { role: 'user', content: user }], 1_800, 180_000, POSTFLIGHT_SCHEMA)) as Record<string, unknown>;
  return normalizePostflightResult(value);
}

export async function summarizeConversation(previous: string | null, messages: ChatMessage[]) {
  const transcript = messages.slice(-30).map((message) => `${message.role.toUpperCase()} (${message.agent}): ${message.content}`).join('\n\n');
  return callGemma([
    { role: 'system', content: 'Maintain compact persistent memory for a software-development conversation. Preserve user goals, selected project paths, decisions, constraints, completed work, failures, and unresolved questions. Do not invent facts. Return concise Markdown only.' },
    { role: 'user', content: `${previous ? `Previous memory:\n${previous}\n\n` : ''}New conversation messages:\n${redactSecrets(transcript).slice(-60_000)}` },
  ], 1_500, 120_000);
}

export async function classifyTask(prompt: string): Promise<{ classification: TaskClassification; source: 'gemma' | 'fallback'; warning?: string }> {
  const system = `Classify a software-agent request. Return JSON only with keys: type (question|implementation|debug|design|review|test), mutating (boolean), complexity (small|normal|deep), riskFlags (string array), codexRole (none|design|debug|review), localOperation (none|connect_git_remote), title (max 60 characters). Use connect_git_remote only when the user wants to tie, link, connect, add, set, or configure a Git remote/origin for the selected project. That operation is small, mutating, has no risk flags, and needs no Codex role. Treat requests to create, edit, fix, implement, commit, or delete as mutating. Architecture, security, root-cause debugging, test design, and review require Codex.`;
  try {
    const text = await callGemma([{ role: 'system', content: system }, { role: 'user', content: prompt }], 700, 60_000, CLASSIFICATION_SCHEMA);
    return { classification: normalizeClassification(validateClassification(parseJson(text), prompt), prompt), source: 'gemma' };
  } catch (error) {
    return { classification: fallbackClassification(prompt), source: 'fallback', warning: error instanceof Error ? error.message : String(error) };
  }
}

export function selectModels(classification: TaskClassification, failedAttempts = 0): ModelSelection {
  if (failedAttempts > 0 || classification.complexity === 'deep' || classification.riskFlags.length > 0) {
    return { antigravity: 'gemini-3.1-pro-high', antigravityEffort: 'high', codex: classification.codexRole === 'none' ? null : 'gpt-5.6-sol', codexEffort: 'high' };
  }
  if (classification.type === 'review' || classification.type === 'test') {
    return { antigravity: 'gemini-3.6-flash-medium', antigravityEffort: 'medium', codex: 'gpt-5.6-luna', codexEffort: 'medium' };
  }
  if (classification.mutating || classification.codexRole !== 'none') {
    return { antigravity: 'gemini-3.6-flash-high', antigravityEffort: 'high', codex: 'gpt-5.6-terra', codexEffort: 'high' };
  }
  return { antigravity: 'gemini-3.6-flash-medium', antigravityEffort: 'medium', codex: null, codexEffort: null };
}

export async function listAntigravityModels(): Promise<string[]> {
  try {
    const result = await runProcess(AGY, ['models'], { timeoutMs: 15_000 });
    return result.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter((line) => /^(gemini|claude|gpt)/.test(line));
  } catch { return []; }
}

export function resolveAntigravityModel(selected: string, available: string[]) {
  if (!available.length || available.includes(selected)) return { model: selected, warning: null };
  const fallback = ['gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low'].find((model) => available.includes(model));
  return { model: fallback || selected, warning: fallback ? `${selected} is unavailable; using ${fallback}.` : 'Unable to verify Antigravity model availability.' };
}

export async function runCodexAnalysis(input: { root: string; prompt: string; role: string; model: string; effort: string; signal: AbortSignal; onOutput: (chunk: string) => void; onUsage?: (value: unknown) => void }): Promise<string> {
  const instruction = `## Task Type: ${input.role}\n\n## Question\n${input.prompt}\n\n## Instructions\nAnalyze the selected repository thoroughly. Do not edit files. Return concrete recommendations and identify blocking risks.`;
  const result = await codexAppServer.runReadOnlyTurn({ ...input, prompt: instruction, onTelemetry: input.onUsage });
  return result.text || 'Codex completed its analysis without a final text response.';
}

export async function runCodexReview(input: { root: string; model: string; effort: string; signal: AbortSignal; onOutput: (chunk: string) => void; onUsage?: (value: unknown) => void }): Promise<string> {
  const prompt = 'Review all staged, unstaged, and untracked changes in the current repository. Inspect the Git diff and relevant surrounding code. Focus on correctness, security, regressions, tests, and scope. Start the final response with VERDICT: PASS or VERDICT: BLOCK. Do not edit files.';
  const result = await codexAppServer.runReadOnlyTurn({ ...input, prompt, onTelemetry: input.onUsage });
  return result.text || 'VERDICT: BLOCK\nCodex review completed without a final verdict.';
}

export async function runAntigravity(input: { root: string; prompt: string; model: string; effort: string; mutating: boolean; conversationId: string | null; context?: string; recovery?: boolean; signal: AbortSignal; onOutput: (chunk: string) => void; onUsage?: (value: unknown) => void }): Promise<AgentRunResult> {
  const prompt = buildAntigravityPrompt(input);
  const args = buildAntigravityArgs({ ...input, prompt });
  const decoder = createAntigravityStreamDecoder(input.onOutput);
  let result;
  try {
    result = await runProcess(AGY, args, { cwd: input.root, timeoutMs: 21 * 60_000, signal: input.signal, onStdout: decoder.push, onStderr: decoder.push });
  } catch (error) {
    decoder.flush();
    if (error instanceof ProcessTimeoutError) {
      throw new Error('Antigravity exceeded its 20-minute print window. Orchestra stopped the process and preserved any uncommitted task changes for safe recovery.');
    }
    throw error;
  }
  decoder.flush();
  if (result.code !== 0) throw new Error(result.stderr || `Antigravity exited with ${result.code}`);
  const terminal = interpretAntigravityOutput(result.stdout, input.mutating);
  const usage = extractAntigravityUsage(result.stdout);
  input.onUsage?.({ conversationId: terminal.conversationId, usage });
  if (!input.mutating && !responseIdentifiesProject(terminal.text, input.root)) {
    throw new Error(`Antigravity's response did not identify the active project directory (${input.root}), so Orchestra rejected it to prevent cross-repository output. Start a new conversation and retry.`);
  }
  return { text: terminal.text, conversationId: terminal.conversationId, raw: result.stdout, warning: terminal.warning, usage };
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

export function buildAntigravityPrompt(input: { root: string; prompt: string; mutating: boolean; context?: string; recovery?: boolean }) {
  const action = input.mutating
    ? 'Implement and verify the request. Do not commit or push; the dashboard owns Git finalization.'
    : 'Answer the request using read-only inspection. Do not modify files.';
  const recovery = input.recovery
    ? 'This is a recovery run. The uncommitted working-tree changes were created by the prior failed attempt at this same request. Inspect and preserve useful partial work, finish missing pieces, correct defects, and verify the complete result.'
    : '';
  return `${input.context ? `A read-only Codex specialist provided this analysis:\n\n${input.context}\n\n` : ''}Authoritative active project directory: ${input.root}\n\nThis exact directory is the repository for the task. Start every repository inspection in this directory and keep all file access inside it. Do not search other drives or choose another repository based on similarly named AGENTS.md files. Treat AGENTS.md as workflow instructions, not as the repository's identity.\n\n${recovery ? `${recovery}\n\n` : ''}User request:\n${input.prompt}\n\n${action}\n\nExecution requirements: run verification commands synchronously to completion. Do not start background tasks, scheduled waits, development/watch servers, or any command that remains running. If a tool automatically creates background work, wait for it directly and cancel or close it before returning. End with a concise result and the verification performed. In the final response, explicitly identify the repository using the authoritative directory above.`;
}

export function interpretAntigravityOutput(output: string, mutating: boolean) {
  const terminal = extractAntigravityTerminalResult(output);
  if (!terminal.text) {
    if (terminal.status && terminal.status !== 'SUCCESS') throw new Error(`Antigravity finished with status ${terminal.status} without a final response.`);
    throw new Error('Antigravity exited successfully but its structured result did not contain a response. Check the Antigravity CLI log and retry.');
  }
  if (terminal.status && terminal.status !== 'SUCCESS') {
    if (mutating) throw new Error(`Antigravity produced output but finished with status ${terminal.status}; Orchestra will not accept a potentially incomplete file-changing run.`);
    return { ...terminal, warning: `Antigravity reported terminal status ${terminal.status} after producing a final read-only response. Orchestra preserved the response.` };
  }
  return { ...terminal, warning: null };
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

export async function summarizeChanges(diff: string, request: string) {
  const redacted = redactSecrets(diff).slice(0, 90_000);
  const text = await callGemma([
    { role: 'system', content: 'You are a technical scribe. Return JSON only: {"title":"conventional commit title <=72 chars","summary":"2-6 concise Markdown bullets describing what changed and verification, without secrets"}.' },
    { role: 'user', content: `Request:\n${request}\n\nDiff:\n${redacted}` },
  ], 900, 60_000, CHANGE_SUMMARY_SCHEMA);
  const parsed = parseJson(text) as Record<string, unknown>;
  const title = String(parsed.title || 'Update project').replace(/[\r\n]/g, ' ').slice(0, 72);
  const summary = String(parsed.summary || '- Updated project files.').trim();
  return { title, summary };
}

export function redactSecrets(value: string) {
  return value
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"']+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_TOKEN]')
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

export function parseJson(text: string): unknown {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (match?.[1] || text).trim();
  try { return JSON.parse(candidate); }
  catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const objectText = candidate.slice(start, end + 1);
      try { return JSON.parse(objectText); }
      catch { return JSON.parse(repairCommonJson(objectText)); }
    }
    throw new Error('Gemma did not return valid JSON');
  }
}

function repairCommonJson(value: string) {
  let result = '';
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && (index === 0 || value[index - 1] !== '\\')) {
      inString = !inString;
      result += character;
      continue;
    }
    if (inString && character === '\\') {
      const next = value[index + 1] || '';
      result += /["\\/bfnrtu]/.test(next) ? character : '\\\\';
      continue;
    }
    if (inString && character === '\n') { result += '\\n'; continue; }
    if (inString && character === '\r') { result += '\\r'; continue; }
    if (inString && character === '\t') { result += '\\t'; continue; }
    result += character;
  }
  return result.replace(/,\s*([}\]])/g, '$1');
}

function normalizeConfidence(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

function validateClassification(value: unknown, prompt: string): TaskClassification {
  const input = value as Partial<TaskClassification>;
  const types = ['question', 'implementation', 'debug', 'design', 'review', 'test'];
  const complexities = ['small', 'normal', 'deep'];
  const roles = ['none', 'design', 'debug', 'review'];
  if (!types.includes(String(input.type)) || typeof input.mutating !== 'boolean' || !complexities.includes(String(input.complexity)) || !roles.includes(String(input.codexRole))) throw new Error('Gemma classification did not match the required schema');
  const riskFlags = normalizeRiskFlags(input.riskFlags);
  const localOperation = input.localOperation === 'connect_git_remote' ? 'connect_git_remote' : 'none';
  return { type: input.type!, mutating: input.mutating, complexity: input.complexity!, riskFlags, codexRole: input.codexRole!, localOperation, title: String(input.title || prompt).slice(0, 60) };
}

export function normalizeClassification(classification: TaskClassification, prompt: string): TaskClassification {
  if (isConnectGitRemoteIntent(prompt) || classification.localOperation === 'connect_git_remote') {
    return { ...classification, type: 'implementation', mutating: true, complexity: 'small', riskFlags: [], codexRole: 'none', localOperation: 'connect_git_remote' };
  }
  if (hasExplicitMutationIntent(prompt)) {
    return { ...classification, type: classification.type === 'question' ? 'implementation' : classification.type, mutating: true };
  }
  const explicitCodexTrigger = /\b(design|architecture|architectural|debug|root cause|security|threat|review|audit|test design|tdd|trade[- ]?off)\b/i.test(prompt);
  if (classification.type === 'question' && !classification.mutating && !explicitCodexTrigger) {
    return { ...classification, complexity: classification.riskFlags.length ? classification.complexity : 'small', codexRole: 'none' };
  }
  return classification;
}

export function hasExplicitMutationIntent(prompt: string) {
  if (/^Orchestra continuation: the user explicitly authorizes implementation and project file changes\./i.test(prompt)) return true;
  if (/\b(?:read[- ]only|do not|don't|without)\s+(?:inspect(?:ion)?\s+and\s+)?(?:modify|edit|change|implement|create|write|commit|push)|\b(?:do not|don't)\s+start\s+(?:implementing|implementation)|\bjust\s+(?:asking|answer|explain|plan)\b/i.test(prompt)) return false;
  const action = '(?:implement|create|build|add|change|edit|fix|remove|delete|update|commit|push)';
  return new RegExp(`^\\s*(?:please\\s+)?${action}\\b`, 'i').test(prompt)
    || new RegExp(`\\b(?:go ahead(?:\\s+and)?|please|can you|could you|i want you to|let(?:'|’)s|proceed to)\\b[\\s\\S]{0,120}\\b${action}\\b`, 'i').test(prompt)
    || new RegExp(`\\b(?:implement|fix|update|add|remove|delete|commit|push)\\s+(?:this|that|it|the|these|those|now)\\b`, 'i').test(prompt)
    || /\bplan(?:\s+out)?\s+and\s+implement\b/i.test(prompt);
}

export function buildContinuationPrompt(prompt: string, previous: Pick<TaskRecord, 'prompt' | 'result' | 'state'> | null) {
  const normalized = prompt.trim().toLowerCase().replace(/[.!?]+$/g, '').trim();
  const continuation = /^(?:yes(?:,?\s+please)?|proceed|continue|go ahead|do it|start|begin|start implementation|begin implementation|implement it|yes,?\s+(?:proceed|continue|go ahead|do it|start|begin))$/.test(normalized);
  if (!continuation || !previous || !['completed', 'completed_unpushed'].includes(previous.state)) return null;
  const priorResult = previous.result?.trim().slice(-6_000);
  return `Orchestra continuation: the user explicitly authorizes implementation and project file changes.\n\nContinue and complete the previously requested work without asking for another approval. Implement and verify the approved next step.\n\nPrevious request:\n${previous.prompt}${priorResult ? `\n\nPrevious task result and proposed next step:\n${priorResult}` : ''}\n\nCurrent user instruction:\n${prompt}`;
}

export function normalizeRiskFlags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((flag) => flag.trim()).filter((flag) => flag && !/^(none|no|n\/a|null|false)$/i.test(flag)).slice(0, 8)
    : [];
}

function fallbackClassification(prompt: string): TaskClassification {
  const lower = prompt.toLowerCase();
  const mutating = /\b(implement|create|add|change|edit|fix|remove|delete|update|build|commit)\b/.test(lower);
  const type = /\b(debug|bug|error|not working|why)\b/.test(lower) ? 'debug' : /\b(design|architecture|plan|approach)\b/.test(lower) ? 'design' : /\b(review|audit|check)\b/.test(lower) ? 'review' : /\btest|tdd\b/.test(lower) ? 'test' : mutating ? 'implementation' : 'question';
  const codexRole = type === 'debug' ? 'debug' : type === 'design' || type === 'test' ? 'design' : type === 'review' ? 'review' : 'none';
  const riskFlags = /\b(security|auth|credential|delete|migration|production)\b/.test(lower) ? ['sensitive-change'] : [];
  const localOperation = isConnectGitRemoteIntent(prompt) ? 'connect_git_remote' : 'none';
  return normalizeClassification({ type, mutating, complexity: riskFlags.length || prompt.length > 1200 ? 'deep' : mutating ? 'normal' : 'small', riskFlags, codexRole, localOperation, title: prompt.slice(0, 60) }, prompt);
}

export function isConnectGitRemoteIntent(prompt: string) {
  return /\b(?:tie|link|connect|add|set|configure)\b[\s\S]{0,80}\b(?:remote|origin)\b/i.test(prompt)
    || /\b(?:remote|origin)\b[\s\S]{0,80}\b(?:tie|link|connect|add|set|configure)\b/i.test(prompt)
    || /\b(?:tie|link|connect)\b[\s\S]{0,50}\brepo(?:sitory)?\b/i.test(prompt);
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

export function decodeCodexProgressLine(line: string): { message: string; onceKey?: string; sandboxFailure?: boolean } | null {
  if (!line.trim()) return null;
  if (/rmcp::transport|Transport channel closed/i.test(line)) return { message: 'An optional MCP connection was unavailable; Codex is continuing without it.', onceKey: 'mcp' };
  if (/CreateProcessAsUserW failed:\s*5|windows sandbox.*Access is denied/i.test(line)) return { message: 'Codex could not start one read-only inspection command in the Windows sandbox.', onceKey: 'sandbox', sandboxFailure: true };
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const item = value.item as Record<string, unknown> | undefined;
    if (value.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return { message: item.text };
    if (value.type === 'item.started' && item?.type === 'todo_list') return { message: `Planning ${Array.isArray(item.items) ? item.items.length : 'the'} analysis steps.` };
    if (value.type === 'item.started' && item?.type === 'command_execution') return { message: friendlyCommandActivity(String(item.command || '')) };
    if (value.type === 'item.completed' && item?.type === 'command_execution' && item.status === 'failed') return { message: 'A read-only repository inspection step failed; Codex is trying another approach.', onceKey: `command-${String(item.id)}` };
  } catch { /* ignore non-JSON diagnostics instead of leaking them to chat */ }
  return null;
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
    if (/step_update/i.test(event)) {
      const step = value.step && typeof value.step === 'object' ? value.step as Record<string, unknown> : value;
      const stepType = String(step.step_type || step.type || '');
      if (/tool|command/i.test(stepType) && !messages.length) messages.push('Antigravity is inspecting or updating the project.');
    }
    return messages.length ? messages : null;
  } catch { return null; }
}

function lineDecoder(_handle: (line: string) => void, sandboxFailed: () => boolean, push: (chunk: string) => void, flush: () => void): StreamDecoder { return { push, flush, sandboxFailed }; }

function friendlyCommandActivity(command: string) {
  if (/\bgit\b/i.test(command)) return 'Inspecting repository and Git state.';
  if (/\b(test|gradle|npm|pytest|build|cmake)\b/i.test(command)) return 'Running a read-only project diagnostic.';
  if (/\b(rg|Get-ChildItem|Get-Content|find)\b/i.test(command)) return 'Inspecting relevant project files.';
  return 'Running a read-only repository inspection step.';
}

export function friendlyCodexError(stderr: string, code: number) {
  const ansiColor = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g');
  const lines = stderr.split(/\r?\n/).map((line) => line.replace(ansiColor, '').trim()).filter(Boolean);
  const explicit = lines.find((line) => /^error:/i.test(line));
  if (explicit) return explicit;
  if (/CreateProcessAsUserW failed:\s*5|windows sandbox.*Access is denied/i.test(stderr)) return 'Codex could not inspect the project because the Windows read-only sandbox failed to start commands.';
  if (/rmcp::transport|Transport channel closed/i.test(stderr)) return 'Codex stopped because an optional MCP transport was unavailable.';
  const detail = lines.findLast((line) => !/^Usage:/i.test(line) && !/^For more information/i.test(line) && line.length < 500);
  return detail || `Codex exited with code ${code}.`;
}

export function sanitizeCodexPath(value: string) {
  return value.split(delimiter).filter((entry) => !/\\WindowsApps(?:\\|$)/i.test(entry)).join(delimiter);
}
