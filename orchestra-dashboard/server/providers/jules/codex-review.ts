import { createHash } from 'node:crypto';
import type { Store } from '../../db.js';
import type { ReviewFinding, ReviewVerdictType } from '../../domain/execution/review.js';
import { extractCodexReviewVerdict, runCodexReview } from '../../agents.js';
import { redactSecrets } from './errors.js';
import type { VerificationResult } from '../../verification.js';

// ============================================================================
// Google Jules Cloud PR: Independent Codex Review Pass
// ============================================================================

export interface JulesReviewPacketInput {
  request: string;
  baseSha: string;
  headSha: string;
  diff: string;
  changedFiles: string[];
  verificationResults?: VerificationResult[];
  previousReview?: string;
}

export interface JulesCodexReviewOptions {
  taskId: string;
  projectRoot: string;
  request: string;
  baseSha: string;
  headSha: string;
  diff: string;
  changedFiles: string[];
  verificationResults?: VerificationResult[];
  previousReview?: string;
  store?: Store;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  codexRunner?: (prompt: string, options: { model: string; effort: 'low' | 'medium' | 'high' }) => Promise<string>;
}

export interface JulesCodexReviewResult {
  verdict: ReviewVerdictType;
  blocked: boolean;
  summary: string;
  findings: ReviewFinding[];
  reviewPacket: string;
  rawReviewText: string;
  model: string;
}

export function computeFindingFingerprint(finding: ReviewFinding): string {
  const normFile = (finding.file || '').replaceAll('\\', '/').toLowerCase().trim();
  const normMsg = finding.explanation.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim().slice(0, 120);
  return createHash('sha256').update(`${finding.severity}:${normFile}:${normMsg}`).digest('hex').slice(0, 16);
}

export function buildJulesReviewPacket(input: JulesReviewPacketInput): string {
  const verificationSection = (input.verificationResults && input.verificationResults.length > 0)
    ? input.verificationResults.map((v) => `### ${v.command} (exit code: ${v.code})\n\`\`\`\n${redactSecrets(v.output).slice(-3000)}\n\`\`\``).join('\n\n')
    : 'No isolated verification scripts configured or executed.';

  const lines = [
    '# Google Jules Cloud PR Review Packet',
    '',
    '## Original user task request',
    redactSecrets(input.request).slice(0, 10_000),
    '',
    '## Jules PR Commit Range',
    `- Base commit SHA: ${input.baseSha}`,
    `- Head commit SHA: ${input.headSha}`,
    '',
    '## Changed files',
    ...input.changedFiles.slice(0, 100).map((f) => `- ${f}`),
    '',
    '## Isolated Verification Results (run in clean worktree)',
    verificationSection,
    '',
    ...(input.previousReview ? ['## Previous Codex Review (confirm repairs, do not repeat obsolete findings)', redactSecrets(input.previousReview).slice(-6_000), ''] : []),
    '## Bounded Git Diff',
    '```diff',
    redactSecrets(input.diff).slice(0, 70_000),
    '```',
    '',
    '## Instructions for Independent Reviewer',
    'Review the Jules cloud worker implementation against the original user task and verification results.',
    '1. Provide an explicit final verdict: `VERDICT: PASS` or `VERDICT: BLOCK`.',
    '2. List any blocking defects, architecture flaws, security vulnerabilities, or regression risks with file and line references.',
  ];

  return lines.join('\n').slice(0, 100_000);
}

export function parseCodexReviewFindings(reviewText: string, changedFiles: string[]): {
  verdict: ReviewVerdictType;
  blocked: boolean;
  summary: string;
  findings: ReviewFinding[];
} {
  const rawVerdict = extractCodexReviewVerdict(reviewText);
  const verdict: ReviewVerdictType = rawVerdict.verdict === 'PASS' ? 'PASS' : 'BLOCK';
  const blocked = verdict === 'BLOCK';

  const findings: ReviewFinding[] = [];
  const lines = reviewText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const fileMap = new Map(changedFiles.map((f) => [f.replaceAll('\\', '/').toLowerCase(), f]));

  for (const line of lines) {
    // Detect bulleted finding items
    const findingMatch = line.match(/^[-*]\s*(?:\[(BLOCKING|WARNING|INFO|CRITICAL|HIGH|MEDIUM|LOW)\])?\s*(.*?)$/i);
    if (findingMatch) {
      const rawSeverity = (findingMatch[1] || '').toUpperCase();
      let severity: ReviewFinding['severity'] = 'warning';
      if (['BLOCKING', 'CRITICAL', 'HIGH'].includes(rawSeverity)) {
        severity = 'blocking';
      } else if (['INFO', 'LOW'].includes(rawSeverity)) {
        severity = 'info';
      }

      const explanation = findingMatch[2].trim();
      if (explanation.length < 5) continue;

      // Extract file reference if mentioned in finding text (e.g. `path/to/file.ts:42` or `path/to/file.ts`)
      let matchedFile: string | undefined;
      let matchedLine: number | undefined;

      const fileLineMatch = explanation.match(/([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)(?::(\d+))?/);
      if (fileLineMatch) {
        const potentialFile = fileLineMatch[1].replaceAll('\\', '/').toLowerCase();
        if (fileMap.has(potentialFile)) {
          matchedFile = fileMap.get(potentialFile);
          if (fileLineMatch[2]) {
            matchedLine = parseInt(fileLineMatch[2], 10);
          }
        }
      }

      findings.push({
        severity,
        file: matchedFile,
        line: matchedLine,
        explanation,
      });
    }
  }

  return {
    verdict,
    blocked,
    summary: rawVerdict.summary,
    findings,
  };
}

export async function runCodexReviewForJules(options: JulesCodexReviewOptions): Promise<JulesCodexReviewResult> {
  const {
    taskId,
    projectRoot,
    request,
    baseSha,
    headSha,
    diff,
    changedFiles,
    verificationResults,
    previousReview,
    store,
    model = 'gpt-5.6-terra',
    effort = 'medium',
    codexRunner,
  } = options;

  // 1. Build bounded, secret-redacted review packet
  const reviewPacket = buildJulesReviewPacket({
    request,
    baseSha,
    headSha,
    diff,
    changedFiles,
    verificationResults,
    previousReview,
  });

  // 2. Invoke Codex Review Pass
  let rawReviewText = '';
  if (codexRunner) {
    rawReviewText = await codexRunner(reviewPacket, { model, effort });
  } else {
    rawReviewText = await runCodexReview({
      root: projectRoot,
      model,
      effort,
      reviewPacket,
      signal: new AbortController().signal,
      onOutput: () => {},
    });
  }

  // 3. Parse verdict and structured findings
  const parsed = parseCodexReviewFindings(rawReviewText, changedFiles);

  // 4. Store review event in SQLite if store is provided
  if (store) {
    store.addEvent(taskId, 'codex', 'cloud.reviewed', {
      verdict: parsed.verdict,
      blocked: parsed.blocked,
      model,
      findingsCount: parsed.findings.length,
      summary: parsed.summary.slice(0, 500),
    });
  }

  return {
    verdict: parsed.verdict,
    blocked: parsed.blocked,
    summary: parsed.summary,
    findings: parsed.findings,
    reviewPacket,
    rawReviewText,
    model,
  };
}
