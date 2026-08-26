export const PROVIDER_IDS = ['gemma', 'jules', 'antigravity', 'codex'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

export const PROVIDER_RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type ProviderRunStatus = typeof PROVIDER_RUN_STATUSES[number];

export type TokenCoverage = 'exact' | 'partial' | 'count-only';

export interface ProviderTokenUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface ProviderRun extends ProviderTokenUsage {
  id: string;
  taskId: string;
  provider: ProviderId;
  operation: string;
  model: string | null;
  primaryWorker: boolean;
  promptFingerprint: string | null;
  estimatedInputTokens: number | null;
  status: ProviderRunStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface UsageWindow extends ProviderTokenUsage {
  invocationCount: number;
  failedCount: number;
  distinctTaskCount: number;
  primaryTaskCount: number;
  coverage: TokenCoverage;
}

export interface ProviderActivity {
  task?: UsageWindow;
  rolling24h: UsageWindow;
  rolling7d: UsageWindow;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_IDS.includes(value as ProviderId);
}

export function isProviderRunStatus(value: unknown): value is ProviderRunStatus {
  return typeof value === 'string' && PROVIDER_RUN_STATUSES.includes(value as ProviderRunStatus);
}

export function normalizeTokenCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
