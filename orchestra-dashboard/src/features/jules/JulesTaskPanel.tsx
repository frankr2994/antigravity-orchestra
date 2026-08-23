import { useCallback, useEffect, useState } from 'react';
import { Cloud, ExternalLink, Send, ShieldCheck } from 'lucide-react';
import type { Task } from '../../app/types';

type ApiClient = <T>(path: string, options?: RequestInit) => Promise<T>;
type CloudSession = { remoteSessionId: string; sourceName: string; state: string; dispatchBranch: string; targetBranch: string; baseSha: string; prHeadSha: string | null; prUrl: string | null };

export function JulesTaskPanel({ task, api }: { task: Task; api: ApiClient }) {
  const [cloud, setCloud] = useState<CloudSession | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = useCallback(() => api<{ cloudSession: CloudSession | null }>(`/api/tasks/${task.id}/jules-session`)
    .then((result) => setCloud(result.cloudSession)).catch(() => setCloud(null)), [api, task.id]);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 5_000); return () => window.clearInterval(timer); }, [refresh]);
  if (!cloud) return null;
  const action = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true); setNotice('');
    try {
      await api(path, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
      setMessage(''); setNotice('Request acknowledged by Jules.'); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="jules-task-panel">
    <header><div><Cloud size={16} /><strong>Jules cloud session</strong></div><span className="pill">{cloud.state}</span></header>
    <div className="jules-task-grid">
      <div><span>Source</span><strong>{cloud.sourceName}</strong></div>
      <div><span>Dispatch base</span><code>{cloud.baseSha.slice(0, 12)}</code></div>
      <div><span>Target</span><strong>{cloud.targetBranch}</strong></div>
      <div><span>Remote session</span><code>{cloud.remoteSessionId}</code></div>
    </div>
    {cloud.prUrl && <a href={cloud.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open Jules pull request</a>}
    {cloud.state === 'AWAITING_PLAN_APPROVAL' && <button className="primary compact" disabled={busy} onClick={() => action(`/api/tasks/${task.id}/jules/approve-plan`)}><ShieldCheck size={13} /> Approve Jules plan</button>}
    {['AWAITING_USER_FEEDBACK', 'PAUSED'].includes(cloud.state) && <div className="jules-message"><textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Send focused guidance to Jules…" /><button className="primary compact" disabled={busy || !message.trim()} onClick={() => action(`/api/tasks/${task.id}/jules/message`, { prompt: message })}><Send size={13} /> Send</button></div>}
    {cloud.state === 'COMPLETED' && cloud.prUrl && <p><ShieldCheck size={13} /> Deterministic verification and independent Codex review are required before automatic fast-forward integration.</p>}
    <small>Pause, resume, and cancel are hidden because Jules does not expose confirmed lifecycle semantics for those actions.</small>
    {notice && <p className="jules-notice">{notice}</p>}
  </section>;
}
