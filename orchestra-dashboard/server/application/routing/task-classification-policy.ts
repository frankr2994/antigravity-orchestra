import type { TaskClassification, TaskRecord } from '../../types.js';

export function validateClassification(value: unknown, prompt: string): TaskClassification {
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
  const isPureRemoteConnect = isConnectGitRemoteIntent(prompt) && prompt.length < 200 && !/\b(scaffold|build|implement|develop|create\s+app|create\s+project|web\s+app|features?)\b/i.test(prompt);
  if ((isConnectGitRemoteIntent(prompt) || classification.localOperation === 'connect_git_remote') && isPureRemoteConnect) {
    return { ...classification, type: 'implementation', mutating: true, complexity: 'small', riskFlags: [], codexRole: 'none', localOperation: 'connect_git_remote' };
  }
  if (hasExplicitMutationIntent(prompt)) {
    return { ...classification, type: classification.type === 'question' ? 'implementation' : classification.type, mutating: true, localOperation: 'none' };
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
  const action = '(?:implement|create|build|add|change|edit|fix|remove|delete|update|commit|push|expand|enhance|refactor|develop|integrate|scaffold)';
  return new RegExp(`^\\s*(?:please\\s+)?${action}\\b`, 'i').test(prompt)
    || new RegExp(`\\b(?:go ahead(?:\\s+and)?|please|can you|could you|i want you to|let(?:'|’)s|proceed to)\\b[\\s\\S]{0,120}\\b${action}\\b`, 'i').test(prompt)
    || new RegExp(`\\b(?:implement|fix|update|add|remove|delete|commit|push|expand|enhance|refactor|develop|integrate)\\s+(?:this|that|it|the|these|those|now)\\b`, 'i').test(prompt)
    || /\bplan(?:\s+out)?\s+and\s+implement\b/i.test(prompt);
}

export function buildContinuationPrompt(prompt: string, previous: Pick<TaskRecord, 'prompt' | 'result' | 'state'> | null) {
  if (!isContinuationCommand(prompt) || !previous || !['completed', 'completed_unpushed'].includes(previous.state)) return null;
  const priorResult = previous.result?.trim().slice(-6_000);
  return `Orchestra continuation: the user explicitly authorizes implementation and project file changes.\n\nContinue and complete the previously requested work without asking for another approval. Implement and verify the approved next step.\n\nPrevious request:\n${previous.prompt}${priorResult ? `\n\nPrevious task result and proposed next step:\n${priorResult}` : ''}\n\nCurrent user instruction:\n${prompt}`;
}

export function isContinuationCommand(prompt: string) {
  const normalized = prompt.trim().toLowerCase().replace(/[.!?]+$/g, '').trim();
  return /^(?:yes(?:,?\s+please)?|proceed|continue|go ahead|do it|start|begin|start implementation|begin implementation|implement it|yes,?\s+(?:proceed|continue|go ahead|do it|start|begin))$/.test(normalized);
}

export function findContinuationRecoveryTask<T extends Pick<TaskRecord, 'state'>>(prompt: string, sessionTasks: T[]): T | null {
  if (!isContinuationCommand(prompt)) return null;
  return sessionTasks.find((task) => task.state === 'recovery_required') || null;
}

export function normalizeRiskFlags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((flag) => flag.trim()).filter((flag) => flag && !/^(none|no|n\/a|null|false)$/i.test(flag)).slice(0, 8)
    : [];
}

export function fallbackClassification(prompt: string): TaskClassification {
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
