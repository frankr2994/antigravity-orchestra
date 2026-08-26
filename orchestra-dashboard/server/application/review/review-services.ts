import { callGemma, type JsonSchema } from '../../providers/lmstudio/chat-client.js';
import { parseJson, redactSecrets } from '../agents/agent-data-utils.js';
import { attachTrustedLocalArtifacts } from '../context/agent-prompt-context.js';
import { buildReviewPromptEnvelope } from '../context/review-prompt-envelope.js';

const REVIEW_TRIAGE_SCHEMA: JsonSchema = { name: 'review_triage', schema: { type: 'object', properties: { risk: { type: 'string', enum: ['low', 'normal', 'high'] }, summary: { type: 'string' }, focusFiles: { type: 'array', items: { type: 'string' } }, concerns: { type: 'array', items: { type: 'string' } } }, required: ['risk', 'summary', 'focusFiles', 'concerns'], additionalProperties: false } };
const DISTILLED_ERRORS_SCHEMA: JsonSchema = { name: 'verification_errors_distillation', schema: { type: 'object', properties: { summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object', properties: { file: { type: ['string', 'null'] }, line: { type: ['integer', 'null'] }, errorType: { type: 'string' }, message: { type: 'string' }, suggestion: { type: 'string' } }, required: ['errorType', 'message'], additionalProperties: false } } }, required: ['summary', 'findings'], additionalProperties: false } };
const PRE_REVIEW_SANITY_SCHEMA: JsonSchema = { name: 'pre_review_sanity_check', schema: { type: 'object', properties: { passed: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['passed', 'issues'], additionalProperties: false } };

export function extractCodexReviewVerdict(reviewText: string): { verdict: 'PASS' | 'BLOCK'; blocked: boolean; summary: string } {
  const trimmed = (reviewText || '').trim();
  if (!trimmed) return { verdict: 'BLOCK', blocked: true, summary: 'No review output returned.' };
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  
  // 1. Look for explicit dedicated verdict lines or headers anywhere in the output
  const verdictLineRegex = /^(?:#+\s*)?(?:\*\*)?(?:Final\s+)?VERDICT:\s*(PASS|BLOCK)(?:\*\*)?/i;
  const explicitVerdicts: Array<'PASS' | 'BLOCK'> = [];
  for (const line of lines) {
    const match = line.match(verdictLineRegex);
    if (match) {
      explicitVerdicts.push(match[1].toUpperCase() as 'PASS' | 'BLOCK');
    }
  }

  if (explicitVerdicts.length > 0) {
    // If explicit verdict lines exist, use the primary/last explicit decision (BLOCK takes precedence if mixed)
    const verdict = explicitVerdicts.includes('BLOCK') ? 'BLOCK' : explicitVerdicts[explicitVerdicts.length - 1];
    return { verdict, blocked: verdict === 'BLOCK', summary: trimmed.slice(0, 3000) };
  }

  // 2. Check for explicit Markdown headers (e.g. ## Verdict: PASS)
  const headerBlock = /^#+\s*(?:Final\s+)?Verdict:?\s*BLOCK\b/im.test(trimmed) || /^\*\*(?:Final\s+)?Verdict:\*\*\s*BLOCK\b/im.test(trimmed);
  const headerPass = /^#+\s*(?:Final\s+)?Verdict:?\s*PASS\b/im.test(trimmed) || /^\*\*(?:Final\s+)?Verdict:\*\*\s*PASS\b/im.test(trimmed);
  if (headerBlock) return { verdict: 'BLOCK', blocked: true, summary: trimmed.slice(0, 3000) };
  if (headerPass) return { verdict: 'PASS', blocked: false, summary: trimmed.slice(0, 3000) };

  // 3. Fallback: if no dedicated verdict line or header was found, treat as BLOCK for safety
  return { verdict: 'BLOCK', blocked: true, summary: trimmed.slice(0, 3000) };
}

export interface ReviewTriage { risk: 'low' | 'normal' | 'high'; summary: string; focusFiles: string[]; concerns: string[]; }

export async function triageReview(input: { request: string; diff: string; changedFiles: string[] }): Promise<ReviewTriage> {
  const raw = await callGemma([
    { role: 'system', content: 'Triage a code-review change set for a stronger independent reviewer. Return JSON only. Identify likely high-value focus files and concrete risk themes. Do not approve or reject the change, do not invent files, and do not execute tools. Use high risk only for credible security, authorization, data-loss, migration, concurrency, or cross-cutting architectural danger.' },
    { role: 'user', content: `Original request:\n${input.request.slice(0, 8_000)}\n\nChanged files:\n${input.changedFiles.slice(0, 100).join('\n')}\n\nBounded diff:\n${redactSecrets(input.diff).slice(0, 45_000)}` },
  ], 900, 60_000, REVIEW_TRIAGE_SCHEMA);
  const value = parseJson(raw) as Record<string, unknown>;
  const allowed = new Map(input.changedFiles.map((file) => [file.replaceAll('\\', '/').toLowerCase(), file]));
  const focusFiles = (Array.isArray(value.focusFiles) ? value.focusFiles : []).map(String).map((file) => allowed.get(file.replaceAll('\\', '/').toLowerCase())).filter((file): file is string => Boolean(file)).slice(0, 20);
  const risk = ['low', 'normal', 'high'].includes(String(value.risk)) ? String(value.risk) as ReviewTriage['risk'] : 'normal';
  return { risk, summary: String(value.summary || '').trim().slice(0, 1_500), focusFiles, concerns: (Array.isArray(value.concerns) ? value.concerns : []).map(String).filter(Boolean).slice(0, 12) };
}

export function buildReviewPacket(input: { request: string; changedFiles: string[]; diff: string; implementationSummary: string; triage: ReviewTriage; previousReview?: string }) {
  const triage = [
    `Risk: ${input.triage.risk}`,
    input.triage.summary || 'No summary was available.',
    ...(input.triage.focusFiles.length ? ['Focus files:', ...input.triage.focusFiles.map((file) => `- ${file}`)] : []),
    ...(input.triage.concerns.length ? ['Potential concerns:', ...input.triage.concerns.map((item) => `- ${item}`)] : []),
  ].join('\n');
  return buildReviewPromptEnvelope({
    request: redactSecrets(attachTrustedLocalArtifacts(input.request)),
    changedFiles: input.changedFiles,
    triage: redactSecrets(triage),
    implementationSummary: redactSecrets(input.implementationSummary),
    previousReview: input.previousReview ? redactSecrets(input.previousReview) : undefined,
    diff: redactSecrets(input.diff),
  }).text;
}

export interface VerificationFinding {
  file: string | null;
  line: number | null;
  errorType: string;
  message: string;
  suggestion?: string;
}

export interface DistilledVerificationResult {
  summary: string;
  findings: VerificationFinding[];
  repairPromptChunk: string;
}

export async function distillVerificationErrors(rawOutput: string, command: string): Promise<DistilledVerificationResult> {
  const sanitized = redactSecrets(rawOutput).slice(-8_000);
  try {
    const text = await callGemma([
      {
        role: 'system',
        content: 'You are an expert compiler and test log distiller. Extract the exact failure points, error types, failing tests, or compiler errors from this terminal log. Return clean JSON only.',
      },
      {
        role: 'user',
        content: `Command executed:\n${command}\n\nTerminal Output:\n${sanitized}`,
      },
    ], 900, 45_000, DISTILLED_ERRORS_SCHEMA);
    const parsed = parseJson(text) as Record<string, unknown>;
    const summary = String(parsed.summary || `Verification command '${command}' failed.`);
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings: VerificationFinding[] = rawFindings.map((f: any) => ({
      file: typeof f.file === 'string' ? f.file : null,
      line: Number.isInteger(f.line) ? f.line : null,
      errorType: String(f.errorType || 'Error'),
      message: String(f.message || ''),
      suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
    }));
    const findingsFormatted = findings.map((f, i) => {
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'General';
      const sug = f.suggestion ? `\n  - Suggested Fix: ${f.suggestion}` : '';
      return `${i + 1}. [${f.errorType}] ${loc}: ${f.message}${sug}`;
    }).join('\n');

    const repairPromptChunk = `### Distilled Verification Failures (${command})\n**Summary:** ${summary}\n\n**Actionable Findings:**\n${findingsFormatted || '- ' + summary}\n\n**Raw Failure Snippet:**\n\`\`\`\n${sanitized.slice(-1500)}\n\`\`\``;

    return { summary, findings, repairPromptChunk };
  } catch {
    const lines = sanitized.split(/\r?\n/).filter((l) => /(?:error|fail|exception|assert)/i.test(l)).slice(-10);
    const summary = `Verification command '${command}' failed with errors.`;
    const fallbackChunk = `### Verification Failure (${command})\n${lines.join('\n') || sanitized.slice(-1000)}`;
    return { summary, findings: [], repairPromptChunk: fallbackChunk };
  }
}

export async function preReviewSanityCheck(input: { root: string; changedFiles: string[]; diff: string }): Promise<{ passed: boolean; issues: string[] }> {
  if (!input.changedFiles.length) return { passed: true, issues: [] };
  const sanitizedDiff = redactSecrets(input.diff).slice(0, 30_000);
  try {
    const text = await callGemma([
      {
        role: 'system',
        content: 'You are a fast syntax and sanity checker. Check this diff for obvious syntax errors, unresolved/missing imports, merge conflict markers (<<<<<<<, >>>>>>>), or empty broken functions. Return JSON: {"passed": boolean, "issues": ["description of issue 1", ...]}',
      },
      {
        role: 'user',
        content: `Files changed:\n${input.changedFiles.join('\n')}\n\nDiff:\n${sanitizedDiff}`,
      },
    ], 500, 30_000, PRE_REVIEW_SANITY_SCHEMA);
    const parsed = parseJson(text) as Record<string, unknown>;
    const passed = parsed.passed === true || !Array.isArray(parsed.issues) || parsed.issues.length === 0;
    const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String).filter(Boolean) : [];
    return { passed, issues };
  } catch {
    return { passed: true, issues: [] };
  }
}

