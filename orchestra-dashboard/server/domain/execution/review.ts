import type { WorkerIdentity } from './attempt.js';

// ============================================================================
// Orchestra Domain: Review & Verification Contracts
// ============================================================================

export type ReviewVerdictType = 'PASS' | 'BLOCK' | 'APPROVED' | 'DISPUTED';

export interface ReviewFinding {
  severity: 'blocking' | 'warning' | 'info';
  file?: string;
  line?: number;
  explanation: string;
  evidence?: string;
  recommendation?: string;
}

export interface ReviewVerdict {
  verdict: ReviewVerdictType;
  blocked: boolean;
  findings: ReviewFinding[];
  summary: string;
  reviewedSha?: string;
  reviewer: WorkerIdentity;
  model: string;
}

export interface VerificationCheck {
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number;
  output?: string;
  durationMs: number;
}

export interface VerificationResult {
  status: 'passed' | 'failed' | 'not_configured';
  verifiedSha: string;
  summary: string;
  durationMs: number;
  checks: VerificationCheck[];
}

export interface ReviewPacketInput {
  request: string;
  diff: string;
  changedFiles: string[];
  implementationSummary: string;
  baseSha?: string;
  prHeadSha?: string;
  verification?: VerificationResult;
  previousReview?: string;
}

/**
 * Validates invariant consistency of a ReviewVerdict.
 * Ensures blocked flag and verdict type are never in contradictory states.
 */
export function validateReviewVerdict(verdict: ReviewVerdict): { valid: boolean; reason?: string } {
  const hasBlockingFindings = Array.isArray(verdict.findings) && verdict.findings.some((f) => f.severity === 'blocking');

  if (verdict.verdict === 'PASS' || verdict.verdict === 'APPROVED') {
    if (verdict.blocked) {
      return {
        valid: false,
        reason: `Review verdict '${verdict.verdict}' cannot have blocked=true.`,
      };
    }
    if (hasBlockingFindings) {
      return {
        valid: false,
        reason: `Review verdict '${verdict.verdict}' cannot contain blocking findings.`,
      };
    }
  }

  if (verdict.verdict === 'BLOCK' || verdict.verdict === 'DISPUTED') {
    if (!verdict.blocked) {
      return {
        valid: false,
        reason: `Review verdict '${verdict.verdict}' requires blocked=true.`,
      };
    }
    if (!hasBlockingFindings && verdict.verdict === 'BLOCK') {
      return {
        valid: false,
        reason: `Review verdict 'BLOCK' requires at least one blocking finding.`,
      };
    }
  }

  return { valid: true };
}
