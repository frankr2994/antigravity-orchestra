import { useCallback, useEffect, useState } from 'react';
import { Cloud, ExternalLink, Send, ShieldCheck, Square } from 'lucide-react';
import type { Task } from '../../app/types';
import { humanState } from '../../shared/format';

type ApiClient = <T>(path: string, options?: RequestInit) => Promise<T>;
type CloudSession = {
  remoteSessionId: string; sourceName: string; state: string; dispatchBranch: string;
  targetBranch: string; baseSha: string; prHeadSha: string | null; prUrl: string | null;
};
type CloudWorkflow = { stage: string; detail: string; nextAction: string | null };
type CloudActivity = { id: number; type: string; createdAt: string; payload: Record<string, unknown> };
type JulesSessionResponse = {
  cloudSession: CloudSession | null;
  workflow: CloudWorkflow | null;
  recentActivity: CloudActivity[];
};

function activityText(activity: CloudActivity): string {
  if (typeof activity.payload.message === 'string') return activity.payload.message;
  if (activity.type === 'cloud.activity') {
    const value = activity.payload.activity;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.description === 'string') return record.description;
      if (typeof record.message === 'string') return record.message;
    }
  }
  return humanState(activity.type);
}

export function JulesTaskPanel({ task, api }: { task: Task; api: ApiClient }) {
  const [session, setSession] = useState<JulesSessionResponse | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = useCallback(() => api<JulesSessionResponse>(`/api/tasks/${task.id}/jules-session`)
    .then(setSession).catch((error) => setNotice(error instanceof Error ? error.message : String(error))), [api, task.id]);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 5_000); return () => window.clearInterval(timer); }, [refresh]);
  const cloud = session?.cloudSession;
  if (!cloud) return null;

  const action = async (path: string, body: Record<string, unknown> = {}, success = 'Request acknowledged by Jules.') => {
    setBusy(true); setNotice('');
    try {
      await api(path, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) });
      setMessage(''); setNotice(success); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!window.confirm('Stop and permanently delete this Jules cloud session?')) return;
    await action(`/api/tasks/${task.id}/jules/cancel`, {}, 'Jules confirmed the session was deleted. The task is stopped.');
  };
  const workflow = session?.workflow;
  const recent = session?.recentActivity?.slice(-8).reverse() ?? [];
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(cloud.state);

  return <section className="jules-task-panel">
    <header><div><Cloud size={16} /><strong>Jules cloud session</strong></div><span className="pill">{humanState(cloud.state)}</span></header>
    {workflow && <div className="latest-work">
      <strong>{humanState(workflow.stage)}</strong>
      <p>{workflow.detail}</p>
      {workflow.nextAction && <small><strong>Next:</strong> {workflow.nextAction}</small>}
    </div>}
    <div className="jules-task-grid">
      <div><span>Source</span><strong>{cloud.sourceName}</strong></div>
      <div><span>Dispatch base</span><code>{cloud.baseSha.slice(0, 12)}</code></div>
      <div><span>Target</span><strong>{cloud.targetBranch}</strong></div>
      <div><span>Remote session</span><code>{cloud.remoteSessionId}</code></div>
    </div>
    {cloud.prUrl && <a href={cloud.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open Jules pull request</a>}
    <div className="monitor-actions">
      {cloud.state === 'AWAITING_PLAN_APPROVAL' && <button className="primary compact" disabled={busy} onClick={() => action(`/api/tasks/${task.id}/jules/approve-plan`)}><ShieldCheck size={13} /> Approve Jules plan</button>}
      {!terminal && <button className="stop-button" disabled={busy} onClick={() => void stop()}><Square size={12} fill="currentColor" /> Stop Jules</button>}
    </div>
    {['AWAITING_USER_FEEDBACK', 'PAUSED'].includes(cloud.state) && <div className="jules-message">
      <textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={cloud.state === 'PAUSED' ? 'Give Jules focused instructions for resuming…' : 'Send focused guidance to Jules…'} />
      <button className="primary compact" disabled={busy || !message.trim()} onClick={() => action(`/api/tasks/${task.id}/jules/message`, { prompt: message }, cloud.state === 'PAUSED' ? 'Guidance sent. Jules can resume the session.' : 'Guidance sent to Jules.')}><Send size={13} /> {cloud.state === 'PAUSED' ? 'Resume Jules with guidance' : 'Send guidance'}</button>
    </div>}
    {cloud.state === 'COMPLETED' && cloud.prUrl && <p><ShieldCheck size={13} /> The PR is being fetched locally, verified in isolation, reviewed independently, and then fast-forwarded only if its exact SHA passes.</p>}
    {recent.length > 0 && <div className="monitor-timeline">
      <header><strong>Jules handoff timeline</strong><small>Newest first</small></header>
      {recent.map((activity) => <div key={activity.id}><time>{new Date(activity.createdAt).toLocaleTimeString()}</time><span className="agent-dot jules" /><b>Jules</b><p>{activityText(activity)}</p></div>)}
    </div>}
    {!terminal && <small>Remote pause is controlled by Jules. Orchestra detects a paused session and lets you resume it by sending guidance here; Stop uses Jules session deletion and waits for confirmation.</small>}
    {notice && <p className="jules-notice">{notice}</p>}
  </section>;
}
