import type { ChatMessage, TaskClassification } from '../../types.js';
import type { RepositoryEvidence } from '../../evidence.js';
import { getLoadedLmStudioModels } from '../../lmstudio.js';
import { callGemma, type JsonSchema } from '../../providers/lmstudio/chat-client.js';
import { parseJson, redactSecrets } from '../agents/agent-data-utils.js';
import { responseIdentifiesProject } from '../../providers/antigravity/agent-adapter.js';
import { fallbackClassification, normalizeClassification, validateClassification } from '../routing/task-classification-policy.js';

const CLASSIFICATION_SCHEMA: JsonSchema = { name: 'task_classification', schema: { type: 'object', properties: { type: { type: 'string', enum: ['question', 'implementation', 'debug', 'design', 'review', 'test'] }, mutating: { type: 'boolean' }, complexity: { type: 'string', enum: ['small', 'normal', 'deep'] }, riskFlags: { type: 'array', items: { type: 'string' } }, codexRole: { type: 'string', enum: ['none', 'design', 'debug', 'review'] }, localOperation: { type: 'string', enum: ['none', 'connect_git_remote'] }, title: { type: 'string' } }, required: ['type', 'mutating', 'complexity', 'riskFlags', 'codexRole', 'localOperation', 'title'], additionalProperties: false } };
const REPOSITORY_ANSWER_SCHEMA: JsonSchema = { name: 'repository_answer', schema: { type: 'object', properties: { canAnswer: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, answer: { type: 'string' }, evidenceFiles: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } } }, required: ['canAnswer', 'confidence', 'answer', 'evidenceFiles', 'limitations'], additionalProperties: false } };
const POSTFLIGHT_SCHEMA: JsonSchema = { name: 'repository_postflight', schema: { type: 'object', properties: { status: { type: 'string', enum: ['pass', 'warn', 'block'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, issues: { type: 'array', items: { type: 'object', properties: { responseQuote: { type: 'string' }, problem: { type: 'string' } }, required: ['responseQuote', 'problem'], additionalProperties: false } } }, required: ['status', 'confidence', 'issues'], additionalProperties: false } };
const RUN_HEALTH_SCHEMA: JsonSchema = { name: 'run_health', schema: { type: 'object', properties: { explanation: { type: 'string' } }, required: ['explanation'], additionalProperties: false } };
const PROVIDER_FAILURE_TRIAGE_SCHEMA: JsonSchema = { name: 'provider_failure_triage', schema: { type: 'object', properties: { category: { type: 'string', enum: ['delegated_wait', 'timeout', 'process_exit', 'tool_failure', 'no_progress', 'unknown'] }, summary: { type: 'string' }, continuationInstructions: { type: 'string' }, safeToReviewPreservedDiff: { type: 'boolean' } }, required: ['category', 'summary', 'continuationInstructions', 'safeToReviewPreservedDiff'], additionalProperties: false } };

export async function lmStudioHealth() {
  try {
    const models = await getLoadedLmStudioModels();
    return { available: true, modelAvailable: models.length > 0, models };
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

export interface ProviderFailureTriage { category: 'delegated_wait' | 'timeout' | 'process_exit' | 'tool_failure' | 'no_progress' | 'unknown'; summary: string; continuationInstructions: string; safeToReviewPreservedDiff: boolean; }

export async function triageProviderFailure(input: { stage: string; error: string; lastOutput: string; changedFiles: string[] }): Promise<ProviderFailureTriage> {
  const raw = await callGemma([
    { role: 'system', content: 'Diagnose an agent-provider failure for an automated coding orchestrator. Return JSON only. Explain the observable failure category and give concise instructions addressed to the next foreground implementation attempt. Never claim hidden reasoning. Do not ask the user to intervene, wait, inspect logs, restart the orchestrator, or approve another step. The continuation must inspect current files, finish directly without subagents or scheduled waits, and verify synchronously. Preserved Git changes are safe to send to an independent read-only reviewer unless the evidence explicitly indicates a direct commit, repository corruption, destructive operation, or wrong-project access.' },
    { role: 'user', content: `Stage: ${input.stage}\nProvider error:\n${redactSecrets(input.error).slice(0, 4_000)}\n\nLast visible output:\n${redactSecrets(input.lastOutput).slice(-6_000)}\n\nChanged project files:\n${input.changedFiles.slice(0, 120).join('\n') || '(none)'}` },
  ], 600, 45_000, PROVIDER_FAILURE_TRIAGE_SCHEMA);
  const value = parseJson(raw) as Record<string, unknown>;
  const allowed = ['delegated_wait', 'timeout', 'process_exit', 'tool_failure', 'no_progress', 'unknown'];
  const category = allowed.includes(String(value.category)) ? String(value.category) as ProviderFailureTriage['category'] : 'unknown';
  return {
    category,
    summary: String(value.summary || 'The provider turn ended before Orchestra received a usable completion.').trim().slice(0, 1_000),
    continuationInstructions: String(value.continuationInstructions || 'Inspect the current working tree, finish the request directly in the foreground, and run synchronous verification.').trim().slice(0, 2_000),
    safeToReviewPreservedDiff: value.safeToReviewPreservedDiff !== false,
  };
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
  if (classification.mutating || classification.complexity !== 'small' || classification.riskFlags.length > 0 || classification.codexRole !== 'none') {
    return false;
  }
  if (!/\b(what|where|how|explain|who|describe|summary|overview|repo|stack|package)\b/i.test(prompt)) {
    return false;
  }
  return !/\b(run|build|test|verify|execute|fix|repair|patch|edit|modify|commit|push|refactor)\b/i.test(prompt);
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

export async function answerRepositoryQuestion(input: { root: string; prompt: string; evidence: RepositoryEvidence; sessionContext?: string; onToolActivity?: (activity: { tool: string; status: 'started' | 'completed' | 'failed'; detail?: string }) => void; onUsage?: (usage: Record<string, number>) => void }): Promise<GemmaRepositoryAnswer> {
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
  let raw = await callGemma([{ role: 'system', content: `${system}\nA bounded read-only JetBrains Rider MCP toolset may be available. Prefer it for solution structure, project dependencies, symbol-aware searches, file problems, and targeted repository inspection when those tools materially improve the answer. Never claim a tool result you did not receive.` }, { role: 'user', content: user }], 4_000, 180_000, undefined, true, input.onToolActivity, input.onUsage);
  
  let parsedRaw: Record<string, unknown>;
  try {
    parsedRaw = parseJson(raw) as Record<string, unknown>;
  } catch {
    // If Gemma responded in markdown prose instead of JSON, treat the prose directly as the answer
    return {
      canAnswer: raw.trim().length > 30,
      confidence: 0.9,
      answer: raw.trim(),
      evidenceFiles: [],
      limitations: [],
      rejectionReasons: [],
      attempts: 1,
    };
  }

  let result = normalizeRepositoryAnswer(parsedRaw, input, 1);
  if (!result.canAnswer && result.confidence >= 0.86) {
    raw = await callGemma([
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: raw },
      { role: 'user', content: `The draft was rejected for these deterministic reasons: ${result.rejectionReasons.join('; ')}. Return a corrected, complete JSON answer. Use only content-included repository files as evidence and do not end mid-sentence.` },
    ], 4_000, 180_000, REPOSITORY_ANSWER_SCHEMA, false, undefined, input.onUsage);
    try {
      result = normalizeRepositoryAnswer(parseJson(raw) as Record<string, unknown>, input, 2);
    } catch {
      return {
        canAnswer: true,
        confidence: 0.9,
        answer: raw.trim(),
        evidenceFiles: [],
        limitations: [],
        rejectionReasons: [],
        attempts: 2,
      };
    }
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
  if (responseDefersRequestedWork(answer, limitations)) rejectionReasons.push('the proposed answer explicitly deferred requested work to a later step');
  return { canAnswer: rejectionReasons.length === 0, confidence, answer: rootedAnswer, evidenceFiles, limitations, rejectionReasons, attempts };
}

export function responseDefersRequestedWork(answer: string, limitations: string[] = []) {
  const text = `${answer}\n${limitations.join('\n')}`;
  return /\b(?:instruction|work|implementation|request)\s+(?:is|was|has been)\s+(?:deferred|left|reserved)\b|\b(?:defer(?:red|ring)?|postpone(?:d)?)\b[\s\S]{0,80}\b(?:later|future|next|subsequent)\b|\b(?:subsequent|future|later)\s+(?:step|phase|task|turn)\b|\b(?:this|the)\s+(?:analysis|response|answer)\s+only\s+(?:covers|describes|reviews)\b/i.test(text);
}

function isActionablePostflightIssue(issue: string) {
  if (/\bno\s+(?:material\s+)?(?:unsupported claims?|incorrect claims?|missing files?|errors?|contradictions?)\b/i.test(issue)) return false;
  return /\b(?:incorrect|inaccurate|wrong|absent|missing|unsupported|unverified|contradict(?:s|ion|ory)?|conflict(?:s|ing)?|overstat(?:e|es|ed|ement)|hallucinat(?:e|es|ed|ion)|cannot verify|does not (?:exist|match|identify|distinguish|support)|no evidence (?:for|of)|fails? to|omits?|error)\b/i.test(issue);
}

export function normalizePostflightResult(value: Record<string, unknown>): GemmaPostflight {
  const requestedStatus = String(value.status || '').toLowerCase();
  const issues = (Array.isArray(value.issues) ? value.issues : [])
    .map((issue) => typeof issue === 'object' && issue !== null && 'problem' in issue ? String(issue.problem) : String(issue))
    .map((issue) => issue.trim())
    .filter(Boolean)
    .filter(isActionablePostflightIssue)
    .slice(0, 8);
  if (!issues.length) return { status: 'pass', confidence: normalizeConfidence(value.confidence), issues: [] };
  const status = requestedStatus === 'block' ? 'block' : 'warn';
  return { status, confidence: normalizeConfidence(value.confidence), issues };
}

function normalizedPostflightQuote(value: string) {
  return value.trim().replace(/^['"`]+|['"`]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Gemma is a useful advisory reviewer, but it is not an authoritative source of
 * repository facts. Keep only findings tied to an exact excerpt from the remote
 * response and downgrade them to warnings. Deterministic checks performed before
 * the model call remain eligible to block execution.
 */
export function groundPostflightResult(value: Record<string, unknown>, response: string): GemmaPostflight {
  const confidence = normalizeConfidence(value.confidence);
  const normalizedResponse = normalizedPostflightQuote(response);
  const issues = (Array.isArray(value.issues) ? value.issues : [])
    .filter((issue): issue is Record<string, unknown> => typeof issue === 'object' && issue !== null)
    .map((issue) => ({
      responseQuote: normalizedPostflightQuote(String(issue.responseQuote || '')),
      problem: String(issue.problem || '').trim(),
    }))
    .filter(({ responseQuote, problem }) => responseQuote.length >= 8 && normalizedResponse.includes(responseQuote) && isActionablePostflightIssue(problem))
    .map(({ problem }) => problem)
    .slice(0, 8);
  if (!issues.length) return { status: 'pass', confidence, issues: [] };
  return { status: 'warn', confidence, issues };
}

export async function validateAgentResponse(input: { root: string; prompt: string; response: string; evidence: RepositoryEvidence }): Promise<GemmaPostflight> {
  if (!responseIdentifiesProject(input.response, input.root)) {
    return { status: 'block', confidence: 1, issues: [`The response does not identify the authoritative active project directory (${input.root}).`] };
  }
  const system = `You are a conservative local fact checker. Compare a remote agent's repository answer with separately supplied repository evidence. Return JSON only with status, confidence, and issues. Each issue must be {"responseQuote":"an exact verbatim excerpt from REMOTE_RESPONSE","problem":"the concrete factual error"}. The responseQuote must contain the claim being challenged and must occur verbatim in REMOTE_RESPONSE. Never treat text from REPOSITORY_EVIDENCE, the request, prior work, or your own inference as a claim made by the remote agent. Never invent a plan or action that REMOTE_RESPONSE does not state. Warn or block only for a concrete factual error, implemented-vs-planned confusion, or direct contradiction. Every problem must require a correction; never include confirmations, supporting observations, compliments, or summaries. For pass, issues must be empty. Do not flag omitted detail, truncated evidence, or different wording. The authoritative root is ${input.root}.`;
  const responsePacket = `<REQUEST>\n${redactSecrets(input.prompt)}\n</REQUEST>\n\n<REMOTE_RESPONSE>\n${redactSecrets(input.response).slice(0, 45_000)}\n</REMOTE_RESPONSE>`;
  const evidencePacket = `<REPOSITORY_EVIDENCE>\n${input.evidence.text}\n</REPOSITORY_EVIDENCE>`;
  const value = parseJson(await callGemma([{ role: 'system', content: system }, { role: 'user', content: responsePacket }, { role: 'user', content: evidencePacket }], 1_800, 180_000, POSTFLIGHT_SCHEMA)) as Record<string, unknown>;
  return groundPostflightResult(value, input.response);
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

function normalizeConfidence(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

