import { PROVIDER_IDS, type ProviderActivity, type ProviderId, type UsageWindow } from '../../domain/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface ProviderUsageReader {
  providerUsage(provider: ProviderId, since: string, taskId?: string): UsageWindow;
}

export class ProviderUsageService {
  constructor(private readonly store: ProviderUsageReader, private readonly now: () => number = Date.now) {}

  activity(taskId?: string): Record<ProviderId, ProviderActivity> {
    const stamp = this.now();
    const day = new Date(stamp - DAY_MS).toISOString();
    const week = new Date(stamp - WEEK_MS).toISOString();
    return Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, {
      ...(taskId ? { task: this.store.providerUsage(provider, new Date(0).toISOString(), taskId) } : {}),
      rolling24h: this.store.providerUsage(provider, day),
      rolling7d: this.store.providerUsage(provider, week),
    }])) as Record<ProviderId, ProviderActivity>;
  }
}
