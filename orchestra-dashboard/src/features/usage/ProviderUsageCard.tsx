import { useMemo, useState } from 'react';
import { Zap } from 'lucide-react';
import type { ProviderUsage, UsageWindow } from '../../app/types';
import { Card, StatusDot } from '../../shared/ui';

type Scope = 'task' | 'rolling24h' | 'rolling7d';
const PROVIDERS = ['gemma', 'jules', 'antigravity', 'codex'] as const;

function resetTimer(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const target = new Date(isoDate).getTime();
  if (!Number.isFinite(target)) return null;
  const minutes = Math.floor((target - Date.now()) / 60_000);
  if (minutes <= 0) return 'resets soon';
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function providerName(provider: typeof PROVIDERS[number]) {
  return provider === 'gemma' ? 'Local Gemma' : provider === 'jules' ? 'Google Jules' : provider === 'antigravity' ? 'Antigravity' : 'OpenAI Codex';
}

function windowLabel(window?: string, name?: string) {
  if (name) return name;
  if (window === '5h') return 'Rolling 5-hour limit';
  if (window === 'weekly') return 'Weekly limit';
  return window ? `${window} limit` : 'Rate limit';
}

function tokenLabel(value: number | null) {
  return value === null ? 'not reported' : value.toLocaleString();
}

export function ProviderUsageCard({ usage, hasTask }: { usage: Record<string, ProviderUsage>; hasTask: boolean }) {
  const [scope, setScope] = useState<Scope>('rolling24h');
  const windows = useMemo(() => PROVIDERS.map((provider) => usage[provider]?.activity?.[scope]).filter((value): value is UsageWindow => Boolean(value)), [scope, usage]);
  const primaryTotal = windows.reduce((total, item) => total + item.primaryTaskCount, 0);
  const callTotal = windows.reduce((total, item) => total + item.invocationCount, 0);
  return <Card title="Provider usage & capacity" icon={<Zap />}>
    <div className="usage-scope-tabs" role="group" aria-label="Usage window">
      <button className={scope === 'task' ? 'active' : ''} disabled={!hasTask} onClick={() => setScope('task')}>Current task</button>
      <button className={scope === 'rolling24h' ? 'active' : ''} onClick={() => setScope('rolling24h')}>24 hours</button>
      <button className={scope === 'rolling7d' ? 'active' : ''} onClick={() => setScope('rolling7d')}>7 days</button>
    </div>
    <div className="provider-usage-grid">
      {PROVIDERS.map((provider) => {
        const item = usage[provider];
        const activity = item?.activity?.[scope];
        const shareBase = primaryTotal > 0 ? primaryTotal : callTotal;
        const shareValue = primaryTotal > 0 ? activity?.primaryTaskCount ?? 0 : activity?.invocationCount ?? 0;
        const share = shareBase ? shareValue / shareBase * 100 : 0;
        return <div key={provider} className="provider-usage-block">
          <div className="provider-block-header"><div className="provider-title"><StatusDot ok={item?.available === true || provider === 'gemma'} /><strong>{providerName(provider)}</strong>{item?.model && <span className="provider-model-badge">{item.model}</span>}</div></div>
          {activity && <div className="provider-workload-grid">
            <span><strong>{activity.invocationCount}</strong> calls</span>
            <span><strong>{activity.distinctTaskCount}</strong> tasks</span>
            <span><strong>{activity.primaryTaskCount}</strong> primary</span>
            <span><strong>{share.toFixed(0)}%</strong> share</span>
            <span title={`Input ${tokenLabel(activity.inputTokens)} · cached ${tokenLabel(activity.cachedInputTokens)} · output ${tokenLabel(activity.outputTokens)}`}><strong>{tokenLabel(activity.totalTokens)}</strong> tokens</span>
            <span className="usage-coverage">{activity.coverage}</span>
          </div>}
          {provider === 'jules' && item?.limitCount !== null && item?.limitCount !== undefined && <div className="jules-usage-counts"><span><strong>{item.usedCount ?? '—'}</strong> used</span><span><strong>{item.remainingCount ?? '—'}</strong> remaining</span><span><strong>{item.activeSessions ?? '—'}</strong> active</span>{item.stale && <span className="pill">Stale</span>}</div>}
          {item?.available && item.quotas?.length ? <div className="quota-pill-list">{item.quotas.map((quota) => {
            const remaining = quota.remainingPercent;
            const status = remaining === null ? 'unknown' : remaining > 30 ? 'good' : remaining > 10 ? 'warning' : 'critical';
            return <div key={quota.id} className={`quota-pill status-${status}`}><div className="quota-pill-header"><span className="quota-group-tag">{quota.group || providerName(provider)}</span><span className="quota-window-tag">{windowLabel(quota.window, quota.name)}</span></div><div className="quota-pill-body"><span className="quota-percent">{remaining === null ? 'Active' : `${remaining.toFixed(1)}% left`}</span>{resetTimer(quota.resetsAt) && <span className="quota-reset-timer">{resetTimer(quota.resetsAt)}</span>}</div></div>;
          })}</div> : <small className="provider-fallback-msg">{item?.available ? item?.source || 'Connected' : item?.reason || 'No provider capacity source; workload counts remain available.'}</small>}
        </div>;
      })}
    </div>
  </Card>;
}
