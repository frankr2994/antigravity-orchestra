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
