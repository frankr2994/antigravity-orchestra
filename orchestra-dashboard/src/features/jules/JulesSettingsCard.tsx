import { useCallback, useEffect, useState } from 'react';
import { Cloud, KeyRound, Trash2 } from 'lucide-react';

type ApiClient = <T>(path: string, options?: RequestInit) => Promise<T>;
type CredentialStatus = { configured: boolean; source?: string; validation?: { ok?: boolean; status?: string; message?: string } };
type QuotaPlan = 'free' | 'pro' | 'ultra' | 'custom';
type RuntimeSettings = { enabled: boolean; rolloutStage: string; quotaPlan: QuotaPlan | null; rolling24HourLimit: number | null };
const PRESETS: Record<Exclude<QuotaPlan, 'custom'>, number> = { free: 15, pro: 100, ultra: 300 };

export function JulesSettingsCard({ api }: { api: ApiClient }) {
  const [available, setAvailable] = useState(false); const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSettings | null>(null);
  const [quotaPlan, setQuotaPlan] = useState<QuotaPlan | ''>('');
  const [customLimit, setCustomLimit] = useState('');
  const [apiKey, setApiKey] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const refresh = useCallback(() => Promise.all([
    api<CredentialStatus>('/api/jules/credential-status'), api<RuntimeSettings>('/api/jules/settings'),
  ]).then(([credential, settings]) => { setAvailable(true); setStatus(credential); setRuntime(settings); setQuotaPlan(settings.quotaPlan ?? ''); if (settings.quotaPlan === 'custom' && settings.rolling24HourLimit) setCustomLimit(String(settings.rolling24HourLimit)); }).catch(() => setAvailable(false)), [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!available) return null;
  const save = async () => {
    setBusy(true); setNotice('');
    try { await api('/api/jules/save-key', { method: 'POST', body: JSON.stringify({ apiKey, validate: true }) }); setApiKey(''); setNotice('Jules credentials validated and stored in the current-user vault.'); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const clear = async () => { setBusy(true); try { await api('/api/jules/clear-key', { method: 'DELETE' }); setNotice('Jules credential removed.'); await refresh(); } finally { setBusy(false); } };
  const toggle = async () => {
    if (!runtime) return; setBusy(true); setNotice('');
    try {
      const enabling = !runtime.enabled;
      if (enabling && !quotaPlan) throw new Error('Choose Free, Pro, Ultra, or Custom before enabling Jules.');
      const rolling24HourLimit = quotaPlan === 'custom' ? Number(customLimit) : quotaPlan ? PRESETS[quotaPlan] : undefined;
      const next = await api<RuntimeSettings>('/api/jules/settings', { method: 'PATCH', body: JSON.stringify({ enabled: enabling, ...(quotaPlan ? { quotaPlan, rolling24HourLimit } : {}) }) });
      setRuntime(next); setNotice(next.enabled ? 'Jules is enabled.' : 'Jules is disabled. Active cloud work is paused locally.');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const saveQuota = async () => {
    if (!quotaPlan) { setNotice('Choose a quota plan.'); return; }
    setBusy(true); setNotice('');
    try {
      const rolling24HourLimit = quotaPlan === 'custom' ? Number(customLimit) : PRESETS[quotaPlan];
      const next = await api<RuntimeSettings>('/api/jules/settings', { method: 'PATCH', body: JSON.stringify({ quotaPlan, rolling24HourLimit }) });
      setRuntime(next); setNotice(`Saved the ${quotaPlan} rolling 24-hour plan (${rolling24HourLimit} sessions).`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="jules-settings-card">
    <header><div><Cloud size={16} /><strong>Google Jules</strong></div><button className={runtime?.enabled ? 'primary compact' : 'secondary compact'} disabled={busy || !runtime} onClick={toggle}>{runtime?.enabled ? 'Enabled' : 'Disabled'}</button></header>
    <p>Turn Jules on or off here at any time. Disabling it prevents new cloud work and pauses local monitoring without deleting remote sessions. The dashboard never displays a saved API key.</p>
    <div className="jules-runtime-state"><span className="pill">{status?.configured ? 'Credential configured' : 'Credential not configured'}</span>{runtime?.enabled && <span className="pill">Cloud features active</span>}</div>
    <div className="jules-quota-config">
      <label><span>Rolling 24-hour quota plan</span><select value={quotaPlan} onChange={(event) => setQuotaPlan(event.target.value as QuotaPlan | '')}>
        <option value="">Choose a plan…</option>
        <option value="free">Free — 15 sessions</option>
        <option value="pro">Pro — 100 sessions</option>
        <option value="ultra">Ultra — 300 sessions</option>
        <option value="custom">Custom</option>
      </select></label>
      {quotaPlan === 'custom' && <label><span>Custom limit (1–10,000)</span><input type="number" min={1} max={10000} step={1} value={customLimit} onChange={(event) => setCustomLimit(event.target.value)} /></label>}
      <button className="secondary compact" disabled={busy || !quotaPlan || quotaPlan === 'custom' && !customLimit} onClick={saveQuota}>Save quota plan</button>
    </div>
    <div className="jules-key-row"><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste a Jules API key" /><button className="primary compact" disabled={busy || !apiKey.trim()} onClick={save}><KeyRound size={13} /> Validate & save</button>{status?.configured && <button className="secondary compact" disabled={busy} onClick={clear}><Trash2 size={13} /> Clear</button>}</div>
    {notice && <small>{notice}</small>}
  </section>;
}
