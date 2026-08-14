import { config } from './config.js';
import { ProcessTimeoutError, runProcess } from './process.js';
import type { ChatMessage, ModelSelection, TaskClassification } from './types.js';
import type { RepositoryEvidence } from './evidence.js';
import { delimiter } from 'node:path';

const AGY = process.platform === 'win32' ? 'agy.exe' : 'agy';
const CODEX = process.platform === 'win32' ? 'codex.exe' : 'codex';

export interface AgentRunResult { text: string; conversationId: string | null; raw: string; warning: string | null; }
interface StreamDecoder { push: (chunk: string) => void; flush: () => void; sandboxFailed: () => boolean; }
let cachedCodexOverrides: { expires: number; args: string[]; disabled: string[] } | null = null;
type JsonSchema = { name: string; schema: Record<string, unknown> };

const CLASSIFICATION_SCHEMA: JsonSchema = { name: 'task_classification', schema: { type: 'object', properties: { type: { type: 'string', enum: ['question', 'implementation', 'debug', 'design', 'review', 'test'] }, mutating: { type: 'boolean' }, complexity: { type: 'string', enum: ['small', 'normal', 'deep'] }, riskFlags: { type: 'array', items: { type: 'string' } }, codexRole: { type: 'string', enum: ['none', 'design', 'debug', 'review'] }, title: { type: 'string' } }, required: ['type', 'mutating', 'complexity', 'riskFlags', 'codexRole', 'title'], additionalProperties: false } };
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

async function callGemma(messages: Array<{ role: string; content: string }>, maxTokens = 700, timeoutMs = 60_000, jsonSchema?: JsonSchema): Promise<string> {
  const response = await fetch(`${config.lmStudioBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.lmStudioModel, messages, temperature: 0.2, max_tokens: maxTokens, ...(jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema } } } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('LM Studio returned an empty response');
  return content;
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
  let raw = await callGemma([{ role: 'system', content: system }, { role: 'user', content: user }], 4_000, 180_000, REPOSITORY_ANSWER_SCHEMA);
  let result = normalizeRepositoryAnswer(parseJson(raw) as Record<string, unknown>, input, 1);
  if (!result.canAnswer && result.confidence >= 0.86) {
    raw = await callGemma([
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: raw },
      { role: 'user', content: `The draft was rejected for these deterministic reasons: ${result.rejectionReasons.join('; ')}. Return a corrected, complete JSON answer. Use only content-included repository files as evidence and do not end mid-sentence.` },
    ], 4_000, 180_000, REPOSITORY_ANSWER_SCHEMA);
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
  const system = `Classify a software-agent request. Return JSON only with keys: type (question|implementation|debug|design|review|test), mutating (boolean), complexity (small|normal|deep), riskFlags (string array), codexRole (none|design|debug|review), title (max 60 characters). Treat requests to create, edit, fix, implement, commit, or delete as mutating. Architecture, security, root-cause debugging, test design, and review require Codex.`;
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

export async function runCodexAnalysis(input: { root: string; prompt: string; role: string; model: string; effort: string; signal: AbortSignal; onOutput: (chunk: string) => void }): Promise<string> {
  const instruction = `## Task Type: ${input.role}\n\n## Question\n${input.prompt}\n\n## Instructions\nAnalyze the selected repository thoroughly. Do not edit files. Return concrete recommendations and identify blocking risks.`;
  const overrides = await getCodexMcpOverrides();
  if (overrides.disabled.length) input.onOutput(`Continuing without unreachable optional MCP: ${overrides.disabled.join(', ')}.`);
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', input.root, '-m', input.model, '-c', `model_reasoning_effort="${input.effort}"`, ...overrides.args, '--json', '-'];
  const decoder = createCodexStreamDecoder(input.onOutput);
  const result = await runProcess(CODEX, args, { input: instruction, env: codexEnvironment(), timeoutMs: 15 * 60_000, signal: input.signal, onStdout: decoder.push, onStderr: decoder.push });
  decoder.flush();
  if (result.code !== 0) throw new Error(friendlyCodexError(result.stderr, result.code));
  const text = extractCodexAgentText(result.stdout);
  if (!text && decoder.sandboxFailed()) throw new Error('Codex could not inspect the project because the Windows read-only sandbox failed to start commands. Run `codex doctor --json` and verify the Windows sandbox before retrying.');
  return text || 'Codex completed its analysis without a final text response.';
}

export async function runCodexReview(input: { root: string; model: string; effort: string; signal: AbortSignal; onOutput: (chunk: string) => void }): Promise<string> {
  const prompt = 'Review all staged, unstaged, and untracked changes in the current repository. Inspect the Git diff and relevant surrounding code. Focus on correctness, security, regressions, tests, and scope. Start the final response with VERDICT: PASS or VERDICT: BLOCK. Do not edit files.';
  const overrides = await getCodexMcpOverrides();
  if (overrides.disabled.length) input.onOutput(`Continuing without unreachable optional MCP: ${overrides.disabled.join(', ')}.`);
  const args = buildCodexReviewArgs({ root: input.root, model: input.model, effort: input.effort, overrideArgs: overrides.args });
  const decoder = createCodexStreamDecoder(input.onOutput);
  const result = await runProcess(CODEX, args, { input: prompt, env: codexEnvironment(), timeoutMs: 15 * 60_000, signal: input.signal, onStdout: decoder.push, onStderr: decoder.push });
  decoder.flush();
  if (result.code !== 0) throw new Error(friendlyCodexError(result.stderr, result.code));
  return extractCodexAgentText(result.stdout) || 'VERDICT: BLOCK\nCodex review completed without a final verdict.';
}

export function buildCodexReviewArgs(input: { root: string; model: string; effort: string; overrideArgs?: string[] }) {
  return ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', input.root, '-m', input.model, '-c', `model_reasoning_effort="${input.effort}"`, ...(input.overrideArgs || []), '--json', '-'];
}

export async function runAntigravity(input: { root: string; prompt: string; model: string; effort: string; mutating: boolean; conversationId: string | null; context?: string; recovery?: boolean; signal: AbortSignal; onOutput: (chunk: string) => void }): Promise<AgentRunResult> {
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
  if (!input.mutating && !responseIdentifiesProject(terminal.text, input.root)) {
    throw new Error(`Antigravity's response did not identify the active project directory (${input.root}), so Orchestra rejected it to prevent cross-repository output. Start a new conversation and retry.`);
  }
  return { text: terminal.text, conversationId: terminal.conversationId, raw: result.stdout, warning: terminal.warning };
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
  return { type: input.type!, mutating: input.mutating, complexity: input.complexity!, riskFlags, codexRole: input.codexRole!, title: String(input.title || prompt).slice(0, 60) };
}

export function normalizeClassification(classification: TaskClassification, prompt: string): TaskClassification {
  const explicitCodexTrigger = /\b(design|architecture|architectural|debug|root cause|security|threat|review|audit|test design|tdd|trade[- ]?off)\b/i.test(prompt);
  if (classification.type === 'question' && !classification.mutating && !explicitCodexTrigger) {
    return { ...classification, complexity: classification.riskFlags.length ? classification.complexity : 'small', codexRole: 'none' };
  }
  return classification;
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
  return { type, mutating, complexity: riskFlags.length || prompt.length > 1200 ? 'deep' : mutating ? 'normal' : 'small', riskFlags, codexRole, title: prompt.slice(0, 60) };
}

function extractCodexAgentText(output: string): string {
  const texts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const item = value.item as Record<string, unknown> | undefined;
      if (value.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') texts.push(item.text);
    } catch { /* stream may contain non-JSON diagnostics */ }
  }
  return [...new Set(texts.filter((text) => text.trim().length > 1))].join('\n').trim();
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

function createCodexStreamDecoder(onOutput: (text: string) => void): StreamDecoder {
  let buffer = ''; let sandboxFailure = false; const notices = new Set<string>();
  const emitOnce = (key: string, text: string) => { if (!notices.has(key)) { notices.add(key); onOutput(text); } };
  const handle = (line: string) => {
    const decoded = decodeCodexProgressLine(line);
    if (!decoded) return;
    if (decoded.sandboxFailure) sandboxFailure = true;
    if (decoded.onceKey) emitOnce(decoded.onceKey, decoded.message);
    else onOutput(decoded.message);
  };
  return lineDecoder(handle, () => sandboxFailure, (chunk) => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) handle(line); }, () => { if (buffer) handle(buffer); buffer = ''; });
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

async function getCodexMcpOverrides() {
  if (cachedCodexOverrides && cachedCodexOverrides.expires > Date.now()) return cachedCodexOverrides;
  const args: string[] = []; const disabled: string[] = [];
  try {
    const result = await runProcess(CODEX, ['mcp', 'list', '--json'], { timeoutMs: 10_000 });
    const servers = JSON.parse(result.stdout) as Array<{ name?: string; enabled?: boolean; transport?: { type?: string; url?: string } }>;
    for (const server of servers) {
      if (!server.enabled || server.transport?.type !== 'streamable_http' || !server.transport.url || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(server.transport.url)) continue;
      try { await fetch(server.transport.url, { method: 'HEAD', signal: AbortSignal.timeout(1200) }); }
      catch {
        const name = String(server.name || '');
        if (/^[A-Za-z0-9_-]+$/.test(name)) { args.push('-c', `mcp_servers.${name}.enabled=false`); disabled.push(name); }
      }
    }
  } catch { /* Codex can still run with its normal configuration */ }
  cachedCodexOverrides = { expires: Date.now() + 60_000, args, disabled };
  return cachedCodexOverrides;
}

function codexEnvironment(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = process.env[pathKey] || '';
  return { [pathKey]: sanitizeCodexPath(currentPath) };
}

export function sanitizeCodexPath(value: string) {
  return value.split(delimiter).filter((entry) => !/\\WindowsApps(?:\\|$)/i.test(entry)).join(delimiter);
}
