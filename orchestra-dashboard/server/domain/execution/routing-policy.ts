import type { TaskClassification } from '../tasks/task.js';

const HIGH_RISK_SCOPE = /\b(?:auth(?:entication|orization)?|credential|secret|security|permission|migration|database schema|package-lock|dependency|dependencies|build system|ci\/cd|delete|remove|rename|binary)\b/i;

export function isGemmaMicroEditCandidate(classification: TaskClassification, prompt: string): boolean {
  return classification.mutating
    && classification.complexity === 'small'
    && classification.riskFlags.length === 0
    && classification.codexRole === 'none'
    && !HIGH_RISK_SCOPE.test(prompt);
}

export interface FreeFirstCapabilities {
  julesReady: boolean;
  julesReason?: string;
}

export interface FreeFirstDecision {
  target: 'local' | 'cloud';
  worker: 'gemma' | 'jules' | 'antigravity';
  reason: string;
}

export function decideFreeFirstRoute(classification: TaskClassification, prompt: string, capabilities: FreeFirstCapabilities): FreeFirstDecision {
  if (!classification.mutating || classification.type === 'question') {
    return { target: 'local', worker: 'gemma', reason: 'Read-only work starts with the local model and escalates only when its evidence gate rejects the answer.' };
  }
  if (isGemmaMicroEditCandidate(classification, prompt)) {
    return { target: 'local', worker: 'gemma', reason: 'A low-risk small mutation qualifies for the bounded local-model candidate workflow.' };
  }
  if (capabilities.julesReady) {
    return { target: 'cloud', worker: 'jules', reason: 'The clean, pushed repository is Jules-ready, so eligible implementation uses cloud capacity before metered local agents.' };
  }
  return { target: 'local', worker: 'antigravity', reason: capabilities.julesReason || 'Jules is unavailable, so implementation falls back to Antigravity.' };
}
