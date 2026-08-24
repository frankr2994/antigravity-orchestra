import { useCallback, useEffect, useState } from 'react';
import { Cloud, ExternalLink, GitPullRequest, RefreshCw, X } from 'lucide-react';
import type { JulesActivitySummary, JulesReadiness, JulesSetupDiagnosis } from '../../app/types';
import { Card, StatusDot } from '../../shared/ui';
import { formatDuration, humanState } from '../../shared/format';

type ApiClient = <T>(path: string, options?: RequestInit) => Promise<T>;

export function JulesServiceRow({
  api, projectId, readiness, onConfigure, onRefresh,
}: {
  api: ApiClient;
  projectId: string | null;
  readiness: JulesReadiness | null;
  onConfigure: () => void;
  onRefresh: (force?: boolean) => Promise<void>;
}) {
  const [diagnosis, setDiagnosis] = useState<JulesSetupDiagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const diagnose = useCallback(async () => {
    if (!projectId) return;
    setBusy(true); setError('');
    try { setDiagnosis(await api<JulesSetupDiagnosis>(`/api/projects/${projectId}/jules/setup-diagnosis`, { method: 'POST', body: '{}' })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [api, projectId]);
  const recheck = useCallback(async () => {
    setBusy(true); setError('');
    try { await onRefresh(true); if (diagnosis) await diagnose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }, [diagnosis, diagnose, onRefresh]);
  useEffect(() => {
    if (!diagnosis) return;
    const onFocus = () => { void recheck(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [diagnosis, recheck]);
  const current = readiness ?? { status: 'yellow' as const, diagnostic: projectId ? 'Checking project readiness…' : 'Select a project to check Jules readiness.', action: null };
  const action = current.action;
  return <>
    <div className="jules-service-row">
      <StatusDot status={current.status} />
      <span>Jules</span>
      <small>{current.diagnostic}</small>
      {action && <button className="secondary compact" disabled={busy || !projectId && action !== 'configure'} onClick={() => {
        if (action === 'configure') onConfigure();
        else if (action === 'setup_repository') void diagnose();
        else void recheck();
      }}>{action === 'configure' ? 'Configure' : action === 'setup_repository' ? 'Set up repository' : 'Retry'}</button>}
    </div>
    {diagnosis && <div className="modal-backdrop" role="presentation">
      <section className="jules-setup-dialog" role="dialog" aria-modal="true" aria-label="Set up Jules repository">
        <header><div><Cloud size={18} /><strong>Set up Jules repository</strong></div><button className="icon-button" onClick={() => setDiagnosis(null)} aria-label="Close"><X size={16} /></button></header>
        <div className="jules-setup-target"><span>Repository</span><strong>{diagnosis.repository ?? 'No valid GitHub remote detected'}</strong><small>Branch: {diagnosis.branch ?? 'not available'}</small></div>
        <p>{diagnosis.diagnostic}</p>
        <ol>{diagnosis.deterministicInstructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
        {diagnosis.tailoredInstructions && <div className="jules-advisor"><strong>Gemma’s tailored guidance</strong><p>{diagnosis.tailoredInstructions}</p><small>Advisory only. Orchestra has not changed Jules or GitHub permissions.</small></div>}
        {error && <small className="error-text">{error}</small>}
        <footer>
          <a className="secondary compact" href={diagnosis.githubInstallationsUrl} target="_blank" rel="noreferrer"><GitPullRequest size={13} /> GitHub Apps</a>
          <button className="primary compact" onClick={() => window.open(diagnosis.authorizationUrl, '_blank', 'noopener,noreferrer')}><ExternalLink size={13} /> Open Jules configuration</button>
          <button className="secondary compact" disabled={busy} onClick={() => void recheck()}><RefreshCw className={busy ? 'spin' : ''} size={13} /> Recheck</button>
        </footer>
      </section>
    </div>}
  </>;
}

export function JulesLiveActivity({ summary }: { summary: JulesActivitySummary | null }) {
  const working = summary?.totals.working ?? 0;
  return <Card title="Jules Live Activity" icon={<Cloud />}>
    {!summary ? <p className="jules-activity-empty">Select a project to view its Jules activity.</p> : !summary.enabled ? <p className="jules-activity-empty">Jules is disabled. Persisted project activity remains available, but provider polling is paused.</p> : <>
      <div className="jules-live-head"><span className={`jules-live-indicator ${working ? 'active' : ''}`} /><strong>{working ? `${working} session${working === 1 ? '' : 's'} working` : 'Jules is idle'}</strong><small>Rolling 24 hours</small></div>
      <div className="jules-activity-counters">
        <div><strong>{summary.totals.working}</strong><span>Working</span></div>
        <div><strong>{summary.totals.attention}</strong><span>Needs attention</span></div>
        <div><strong>{summary.totals.completed}</strong><span>Completed by Jules</span></div>
        <div><strong>{summary.totals.failed}</strong><span>Failed</span></div>
      </div>
      <small className="jules-completion-note">Completed by Jules means provider execution finished; Orchestra review, repair, and integration may still be pending.</small>
      {summary.tasks.length > 0 && <div className="jules-activity-list">{summary.tasks.map((task) => <div key={task.taskId}>
        <StatusDot status={task.providerState === 'FAILED' ? 'red' : ['AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'PAUSED'].includes(task.providerState) ? 'yellow' : 'green'} />
        <div><strong>{task.title}</strong><small>{humanState(task.providerState)} · Orchestra: {humanState(task.workflowPhase)} · {task.finishedAt ? `finished ${new Date(task.finishedAt).toLocaleString()}` : formatDuration(task.elapsedMs)}</small></div>
        {task.prUrl && <a href={task.prUrl} target="_blank" rel="noreferrer" title="Open pull request"><GitPullRequest size={15} /></a>}
      </div>)}</div>}
    </>}
  </Card>;
}
