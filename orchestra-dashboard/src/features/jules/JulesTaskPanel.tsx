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
  currentPlan: Record<string, unknown> | null;
  automation: { state: string; handler: string | null; model: string | null; effort: string | null; reason: string | null; pendingCommand: { kind: string; state: string } | null; retryAt: string | null; authoritativeTaskState: string } | null;
  planReview: Record<string, unknown> | null;
  outstandingRepair: { headSha: string; findingsFingerprint: string; status: string } | null;
};
type PlanStep = { index?: number; title: string; description?: string; status?: string };

function activityText(activity: CloudActivity): string {
  if (typeof activity.payload.message === 'string') return activity.payload.message;
  if (activity.type === 'cloud.activity') {
    if (typeof activity.payload.description === 'string') return activity.payload.description;
    if (typeof activity.payload.message === 'string') return activity.payload.message;
    if (activity.payload.kind === 'plan_generated') return 'Jules generated an implementation plan for local review.';
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
  const planPayload = session?.currentPlan;
  const planSteps: PlanStep[] = Array.isArray(planPayload?.steps)
    ? planPayload.steps.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const step = value as Record<string, unknown>;
      if (typeof step.title !== 'string') return [];
      return [{ title: step.title, ...(Number.isSafeInteger(step.index) ? { index: Number(step.index) } : {}),
        ...(typeof step.description === 'string' ? { description: step.description } : {}),
        ...(typeof step.status === 'string' ? { status: step.status } : {}) }];
    }) : [];
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(cloud.state);
  const pendingCommand = session?.automation?.pendingCommand;
  const automationOwnsAttention = ['feedback_acknowledged', 'awaiting_provider_resume'].includes(session?.automation?.state || '');
  const durableBusy = busy || automationOwnsAttention || Boolean(pendingCommand && ['pending', 'acknowledged', 'ambiguous'].includes(pendingCommand.state));

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
    {session?.automation && <div className="latest-work">
      <strong>Automation: {humanState(session.automation.state)}</strong>
      <p>{session.automation.handler || 'durable state'}{session.automation.model ? ` · ${session.automation.model}${session.automation.effort ? ` (${session.automation.effort})` : ''}` : ''}</p>
      {session.automation.reason && <small>{session.automation.reason}</small>}
      {session.automation.retryAt && <small>Retry: {new Date(session.automation.retryAt).toLocaleString()}</small>}
    </div>}
    {planSteps.length > 0 && <div className="jules-plan">
      <header><strong>Jules implementation plan</strong><small>Reviewed locally by Orchestra before approval</small></header>
      <ol>{planSteps.map((step, index) => <li key={`${step.index ?? index}-${step.title}`}>
        <strong>{step.title}</strong>
        {step.description && <p>{step.description}</p>}
      </li>)}</ol>
    </div>}
    <div className="monitor-actions">
      {!terminal && <button className="stop-button" disabled={busy} onClick={() => void stop()}><Square size={12} fill="currentColor" /> Stop Jules</button>}
    </div>
    {session?.planReview && <details><summary>Plan review findings and checklist progress</summary><pre>{JSON.stringify(session.planReview, null, 2)}</pre></details>}
    {session?.outstandingRepair && <div className="latest-work"><strong>Outstanding repair</strong><p>{humanState(session.outstandingRepair.status)} · head {session.outstandingRepair.headSha.slice(0, 12)}</p></div>}
    {['AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'PAUSED'].includes(cloud.state) && <details className="jules-message">
      <summary>Emergency manual controls</summary>
      {cloud.state === 'AWAITING_PLAN_APPROVAL' && <button className="compact" disabled={durableBusy} onClick={() => action(`/api/tasks/${task.id}/jules/approve-plan`)}><ShieldCheck size={13} /> Manual approval override</button>}
      <textarea rows={3} value={message} disabled={durableBusy} onChange={(event) => setMessage(event.target.value)} placeholder={cloud.state === 'PAUSED' ? 'Give Jules focused instructions for resuming…' : 'Send focused guidance to Jules…'} />
      <button className="primary compact" disabled={durableBusy || !message.trim()} onClick={() => action(`/api/tasks/${task.id}/jules/message`, { prompt: message }, cloud.state === 'PAUSED' ? 'Guidance sent. Jules can resume the session.' : 'Guidance sent to Jules.')}><Send size={13} /> {cloud.state === 'PAUSED' ? 'Resume Jules with guidance' : 'Send guidance'}</button>
    </details>}
    {cloud.state === 'COMPLETED' && cloud.prUrl && <p><ShieldCheck size={13} /> The PR is being fetched locally, verified in isolation, reviewed independently, and then fast-forwarded only if its exact SHA passes.</p>}
    {recent.length > 0 && <div className="monitor-timeline">
      <header><strong>Jules handoff timeline</strong><small>Newest first</small></header>
      {recent.map((activity) => <div key={activity.id}><time>{new Date(activity.createdAt).toLocaleTimeString()}</time><span className="agent-dot jules" /><b>Jules</b><p>{activityText(activity)}</p></div>)}
    </div>}
    {!terminal && <small>Orchestra automatically resolves ordinary Jules pauses and clarifications. Emergency guidance remains available only when no durable automatic response is pending; Stop uses Jules session deletion and waits for confirmation.</small>}
    {notice && <p className="jules-notice">{notice}</p>}
  </section>;
}
