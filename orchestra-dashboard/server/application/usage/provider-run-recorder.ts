import type { Store } from '../../db.js';
import { normalizeTokenCount, type AgentName, type ProviderId, type ProviderTokenUsage, type TaskEvent } from '../../domain/index.js';

const PROVIDER_AGENTS = new Set<AgentName>(['gemma', 'jules', 'antigravity', 'codex']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function operation(payload: Record<string, unknown>): string {
  return String(payload.role || payload.phase || payload.operation || 'provider-turn').trim().slice(0, 120) || 'provider-turn';
}

export function providerTokens(value: unknown): Partial<ProviderTokenUsage> {
  const payload = asRecord(value);
  const usage = asRecord(payload.usage && typeof payload.usage === 'object' ? payload.usage : payload);
  return {
    inputTokens: normalizeTokenCount(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens),
    cachedInputTokens: normalizeTokenCount(usage.cachedInputTokens ?? usage.cached_input_tokens ?? usage.cache_read_tokens),
    outputTokens: normalizeTokenCount(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens),
    reasoningTokens: normalizeTokenCount(usage.reasoningOutputTokens ?? usage.reasoning_tokens ?? usage.thinking_tokens),
    totalTokens: normalizeTokenCount(usage.totalTokens ?? usage.total_tokens),
  };
}

function isPrimary(provider: ProviderId, name: string): boolean {
  if (provider === 'jules') return true;
  return ['direct-chat', 'repository-answer', 'implementation', 'local-operation', 'micro-edit'].includes(name);
}

export class ProviderRunRecorder {
  private readonly active = new Map<string, { id: string; usage: Partial<ProviderTokenUsage> }>();

  constructor(private readonly store: Pick<Store, 'startProviderRun' | 'finishProviderRun' | 'finishActiveProviderRun'>) {}

  observe(event: TaskEvent): void {
    const provider = PROVIDER_AGENTS.has(event.agent) ? event.agent as ProviderId : null;
    const payload = asRecord(event.payload);
    if (provider && event.type === 'agent.started') {
      // Keep the ledger closed even if a provider emits a new turn before its
      // prior terminal event (for example after a worker restart).
      this.finish(event.taskId, provider, 'cancelled');
      const name = operation(payload);
      const run = this.store.startProviderRun({
        taskId: event.taskId,
        provider,
        operation: name,
        model: typeof payload.model === 'string' ? payload.model : null,
        primaryWorker: isPrimary(provider, name),
        promptFingerprint: typeof payload.packetFingerprint === 'string' ? payload.packetFingerprint : null,
        estimatedInputTokens: normalizeTokenCount(payload.estimatedInputTokens),
      });
      this.active.set(this.key(event.taskId, provider), { id: run.id, usage: {} });
      return;
    }
    if (provider && event.type === 'provider.telemetry') {
      const active = this.active.get(this.key(event.taskId, provider));
      if (active) active.usage = providerTokens(payload);
      return;
    }
    if (provider && (event.type === 'agent.completed' || event.type === 'agent.failed')) {
      this.finish(event.taskId, provider, event.type === 'agent.failed' ? 'failed' : 'completed');
      return;
    }
    if (event.type === 'task.state') {
      const state = String(payload.state || '');
      const status = state === 'cancelled' || state === 'paused' ? 'cancelled'
        : state === 'failed' || state === 'recovery_required' ? 'failed'
          : null;
      if (status) for (const candidate of PROVIDER_AGENTS) this.finish(event.taskId, candidate as ProviderId, status);
      return;
    }
    if (event.type === 'task.failed' || event.type === 'task.cancelled') {
      for (const candidate of PROVIDER_AGENTS) this.finish(event.taskId, candidate as ProviderId, event.type === 'task.cancelled' ? 'cancelled' : 'failed');
    }
  }

  private finish(taskId: string, provider: ProviderId, status: 'completed' | 'failed' | 'cancelled') {
    const key = this.key(taskId, provider);
    const active = this.active.get(key);
    if (active) {
      this.store.finishProviderRun(active.id, status, active.usage);
      this.active.delete(key);
      return;
    }
    // Reconcile a persisted run after a process restart, when the in-memory
    // event pairing map is intentionally empty.
    this.store.finishActiveProviderRun(taskId, provider, status);
  }

  private key(taskId: string, provider: ProviderId) { return `${taskId}:${provider}`; }
}

export type ProviderRunEventObserver = (event: TaskEvent) => void;
