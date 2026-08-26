import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isProviderId,
  isProviderRunStatus,
  normalizeTokenCount,
  type ProviderId,
  type ProviderRun,
  type ProviderRunStatus,
  type ProviderTokenUsage,
  type UsageWindow,
} from '../../../domain/index.js';

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} is invalid`);
  return value;
}

function mapRun(row: unknown): ProviderRun {
  const value = row as Record<string, unknown>;
  if (!isProviderId(value.provider)) throw new TypeError(`Persisted provider run contains invalid provider '${String(value.provider)}'`);
  if (!isProviderRunStatus(value.status)) throw new TypeError(`Persisted provider run contains invalid status '${String(value.status)}'`);
  return {
    id: String(value.id),
    taskId: String(value.task_id),
    provider: value.provider,
    operation: String(value.operation),
    model: typeof value.model === 'string' ? value.model : null,
    primaryWorker: Number(value.primary_worker) === 1,
    promptFingerprint: typeof value.prompt_fingerprint === 'string' ? value.prompt_fingerprint : null,
    estimatedInputTokens: normalizeTokenCount(value.estimated_input_tokens),
    status: value.status,
    inputTokens: normalizeTokenCount(value.input_tokens),
    cachedInputTokens: normalizeTokenCount(value.cached_input_tokens),
    outputTokens: normalizeTokenCount(value.output_tokens),
    reasoningTokens: normalizeTokenCount(value.reasoning_tokens),
    totalTokens: normalizeTokenCount(value.total_tokens),
    startedAt: timestamp(value.started_at, 'provider run start'),
    completedAt: value.completed_at === null ? null : timestamp(value.completed_at, 'provider run completion'),
  };
}

const emptyWindow = (): UsageWindow => ({
  invocationCount: 0,
  failedCount: 0,
  distinctTaskCount: 0,
  primaryTaskCount: 0,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  coverage: 'count-only',
});

function aggregate(rows: ProviderRun[]): UsageWindow {
  if (!rows.length) return emptyWindow();
  const taskIds = new Set(rows.map((row) => row.taskId));
  const primaryTasks = new Set(rows.filter((row) => row.primaryWorker).map((row) => row.taskId));
  const tokenRows = rows.filter((row) => row.totalTokens !== null || row.inputTokens !== null || row.outputTokens !== null);
  const sum = (key: keyof ProviderTokenUsage) => {
    const values = tokenRows.map((row) => row[key]).filter((value): value is number => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    invocationCount: rows.length,
    failedCount: rows.filter((row) => row.status === 'failed').length,
    distinctTaskCount: taskIds.size,
    primaryTaskCount: primaryTasks.size,
    inputTokens: sum('inputTokens'),
    cachedInputTokens: sum('cachedInputTokens'),
    outputTokens: sum('outputTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
    coverage: tokenRows.length === rows.length ? 'exact' : tokenRows.length ? 'partial' : 'count-only',
  };
}

export class ProviderRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  start(input: { taskId: string; provider: ProviderId; operation: string; model?: string | null; primaryWorker?: boolean; promptFingerprint?: string | null; estimatedInputTokens?: number | null; startedAt?: string }): ProviderRun {
    if (!isProviderId(input.provider)) throw new TypeError('Provider run provider is invalid');
    const operation = input.operation.trim();
    if (!operation || operation.length > 120) throw new TypeError('Provider run operation is invalid');
    const id = randomUUID();
    const startedAt = input.startedAt ?? new Date().toISOString();
    timestamp(startedAt, 'provider run start');
    const fingerprint = input.promptFingerprint && /^[0-9a-f]{64}$/i.test(input.promptFingerprint) ? input.promptFingerprint.toLowerCase() : null;
    const estimatedInputTokens = normalizeTokenCount(input.estimatedInputTokens);
    this.db.prepare(`INSERT INTO provider_runs
      (id,task_id,provider,operation,model,primary_worker,prompt_fingerprint,estimated_input_tokens,status,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, input.taskId, input.provider, operation, input.model ?? null, input.primaryWorker ? 1 : 0, fingerprint, estimatedInputTokens, 'running', startedAt);
    return this.get(id)!;
  }

  finish(id: string, status: Exclude<ProviderRunStatus, 'running'>, usage: Partial<ProviderTokenUsage> = {}, completedAt = new Date().toISOString()): ProviderRun {
    if (!isProviderRunStatus(status)) throw new TypeError('Provider run completion status is invalid');
    timestamp(completedAt, 'provider run completion');
    const current = this.get(id);
    if (!current) throw new Error(`Provider run '${id}' was not found`);
    if (current.status !== 'running') return current;
    const tokens = {
      inputTokens: normalizeTokenCount(usage.inputTokens),
      cachedInputTokens: normalizeTokenCount(usage.cachedInputTokens),
      outputTokens: normalizeTokenCount(usage.outputTokens),
      reasoningTokens: normalizeTokenCount(usage.reasoningTokens),
      totalTokens: normalizeTokenCount(usage.totalTokens),
    };
    this.db.prepare(`UPDATE provider_runs SET status=?,input_tokens=?,cached_input_tokens=?,output_tokens=?,reasoning_tokens=?,total_tokens=?,completed_at=? WHERE id=? AND status='running'`)
      .run(status, tokens.inputTokens, tokens.cachedInputTokens, tokens.outputTokens, tokens.reasoningTokens, tokens.totalTokens, completedAt, id);
    return this.get(id)!;
  }

  get(id: string): ProviderRun | null {
    const row = this.db.prepare('SELECT * FROM provider_runs WHERE id=?').get(id);
    return row ? mapRun(row) : null;
  }

  findRunning(taskId: string, provider: ProviderId): ProviderRun | null {
    if (!isProviderId(provider)) throw new TypeError('Provider run provider is invalid');
    const row = this.db.prepare(`SELECT * FROM provider_runs
      WHERE task_id=? AND provider=? AND status='running'
      ORDER BY started_at DESC LIMIT 1`).get(taskId, provider);
    return row ? mapRun(row) : null;
  }

  list(provider: ProviderId, since: string, taskId?: string): ProviderRun[] {
    if (!isProviderId(provider)) throw new TypeError('Provider run provider is invalid');
    timestamp(since, 'provider run window');
    const rows = taskId
      ? this.db.prepare('SELECT * FROM provider_runs WHERE provider=? AND task_id=? AND started_at>=? ORDER BY started_at').all(provider, taskId, since)
      : this.db.prepare('SELECT * FROM provider_runs WHERE provider=? AND started_at>=? ORDER BY started_at').all(provider, since);
    return rows.map(mapRun);
  }

  summarize(provider: ProviderId, since: string, taskId?: string): UsageWindow {
    return aggregate(this.list(provider, since, taskId));
  }

  prune(before: string): number {
    timestamp(before, 'provider run retention boundary');
    return Number(this.db.prepare('DELETE FROM provider_runs WHERE started_at<?').run(before).changes);
  }
}
