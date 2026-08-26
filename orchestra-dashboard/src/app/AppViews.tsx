import { useState } from 'react';
import {
  Activity, CircleAlert, Cpu, FolderGit2, FolderOpen, MemoryStick, Pause, Play,
  RefreshCw, Send, Server, Square, Terminal, Trash2,
} from 'lucide-react';
import type {
  Health, JulesActivitySummary, JulesReadiness, McpStatus, Project, ProviderUsage, RunMonitor,
  Stats, Task, TaskEvent,
} from './types';
import { Card, Empty, Metric, PageHeader, StatusDot } from '../shared/ui';
import { formatDuration, humanState } from '../shared/format';
import { JulesLiveActivity, JulesServiceRow } from '../features/jules/JulesDashboard';
import { JulesTaskPanel } from '../features/jules/JulesTaskPanel';
import { ProviderUsageCard } from '../features/usage/ProviderUsageCard';
import { terminalStates } from './task-state';

export function Dashboard({ api, stats, health, usage, julesReadiness, julesActivity, mcp, project, tasks, activeTask, monitor, events, explanation, explanationBusy, question, onQuestion, onAsk, onExplain, onPause, onResume, onStop, onConfigureJules, onRefreshJules }: { api: <T>(path: string, options?: RequestInit) => Promise<T>; stats: Stats | null; health: Health; usage: Record<string, ProviderUsage>; julesReadiness: JulesReadiness | null; julesActivity: JulesActivitySummary | null; mcp: McpStatus | null; project: Project | null; tasks: Task[]; activeTask: Task | null; monitor: RunMonitor | null; events: TaskEvent[]; explanation: string; explanationBusy: boolean; question: string; onQuestion: (value: string) => void; onAsk: () => void; onExplain: () => void; onPause: (task?: Task | null) => void; onResume: (task?: Task | null) => void; onStop: (task?: Task | null) => void; onConfigureJules: () => void; onRefreshJules: (force?: boolean) => Promise<void> }) {
  const running = tasks.filter((task) => !terminalStates.has(task.state)).length;
  return <section><PageHeader eyebrow="Local system and agent status" title="Command Center" subtitle={project ? `Working directory: ${project.root}` : 'Select a project to begin.'} />
    {activeTask && <LiveRunMonitor task={activeTask} monitor={monitor} events={events} explanation={explanation} explanationBusy={explanationBusy} question={question} onQuestion={onQuestion} onAsk={onAsk} onExplain={onExplain} onPause={onPause} onResume={onResume} onStop={onStop} />}
    {activeTask?.target === 'cloud' && <JulesTaskPanel task={activeTask} api={api} />}
    <div className="metrics-grid">
      <Metric icon={<Cpu />} label="CPU" value={`${stats?.cpu.load ?? 0}%`} detail={stats?.cpu.speed || 'Unavailable'} percent={stats?.cpu.load ?? 0} color="blue" />
      <Metric icon={<MemoryStick />} label="Memory" value={`${stats?.memory.percent ?? 0}%`} detail={stats ? `${stats.memory.used} / ${stats.memory.total} GB` : 'Loading'} percent={stats?.memory.percent ?? 0} color="cyan" />
      <Metric icon={<Activity />} label="GPU" value={stats?.gpu.load === null || stats?.gpu.load === undefined ? 'N/A' : `${stats.gpu.load}%`} detail={stats ? `${stats.gpu.temp === null ? 'Temp N/A' : `${stats.gpu.temp}°C`} · ${stats.gpu.name}` : 'Loading'} percent={stats?.gpu.load ?? 0} color="green" />
    </div>
    <div className="two-column">
      <Card title="Agent services" icon={<Server />}><div className="service-list">{Object.entries(health).map(([name, item]) => <div key={name}><StatusDot status={item.status} ok={item.available !== false && (item.modelAvailable ?? true)} /><span>{name}</span><small>{item.version || (item.modelAvailable === false ? 'Model missing' : item.available === false ? 'Unavailable' : 'Ready')}</small></div>)}<JulesServiceRow api={api} projectId={project?.id ?? null} readiness={julesReadiness} onConfigure={onConfigureJules} onRefresh={onRefreshJules} /></div></Card>
      <ProviderUsageCard usage={usage} hasTask={Boolean(activeTask)} />
    </div>
    <div className="jules-live-card"><JulesLiveActivity summary={julesActivity} /></div>
    <div className="mcp-panel"><Card title="Rider MCP" icon={<Terminal />}>
      <div className="mcp-server"><StatusDot ok={mcp?.server.operational === true} /><div><strong>{mcp?.server.name || 'Checking Rider MCP…'}</strong><small>{mcp?.server.operational ? `${mcp.server.toolCount} tools · v${mcp.server.version || 'unknown'} · ${mcp.server.latencyMs ?? '?'} ms` : mcp?.server.reason || 'Waiting for the first protocol check.'}</small><code>{mcp?.server.endpoint || 'No endpoint discovered'}</code></div></div>
      <div className="mcp-agent-grid">{(['antigravity', 'codex', 'gemma'] as const).map((agent) => { const status = mcp?.agents[agent]; return <div key={agent}><StatusDot ok={status?.available === true} /><strong>{agent}</strong><span>{status?.available ? `${status.access} access` : 'unavailable'}</span><small>{status?.available ? agent === 'gemma' ? 'Orchestra read-only tool bridge ready' : 'Configured and endpoint operational' : status?.reason || 'Checking configuration…'}</small></div>; })}</div>
    </Card></div>
    <div className="summary-strip"><div><strong>{running}</strong><span>Active tasks</span></div><div><strong>{tasks.filter((task) => task.state === 'completed').length}</strong><span>Completed</span></div><div><strong>{tasks.filter((task) => task.state === 'completed_unpushed').length}</strong><span>Awaiting push</span></div></div>
  </section>;
}

export function LiveRunMonitor({ task, monitor, events, explanation, explanationBusy, question, onQuestion, onAsk, onExplain, onPause, onResume, onStop }: { task: Task; monitor: RunMonitor | null; events: TaskEvent[]; explanation: string; explanationBusy: boolean; question: string; onQuestion: (value: string) => void; onAsk: () => void; onExplain: () => void; onPause: (task?: Task | null) => void; onResume: (task?: Task | null) => void; onStop: (task?: Task | null) => void }) {
  const [showLogs, setShowLogs] = useState(false);
  const recent = events.filter((event) => ['task.state', 'task.paused', 'task.resumed', 'task.repair-progress', 'task.provider-recovery', 'task.model-takeover', 'task.takeover_local', 'routing.adjustment', 'mcp.capability', 'mcp.tool', 'agent.started', 'agent.output', 'agent.completed', 'provider.telemetry', 'verification.result', 'git.commit', 'git.push', 'cloud.activity', 'cloud.completed', 'cloud.reviewing', 'cloud.reviewed', 'cloud.repair_requested', 'cloud.cancelled', 'cloud.integrated'].includes(event.type)).slice(-25).reverse();
  const latestKnownWork = recent.find((event) => event.type === 'agent.output' || event.type === 'agent.completed' || event.type === 'task.provider-recovery' || event.type === 'task.model-takeover');
  const running = !terminalStates.has(task.state);
  const stoppable = running && !(task.target === 'cloud' && monitor?.providerState === 'COMPLETED');
  return <article className={`live-monitor health-${monitor?.health || 'waiting'}`}>
    <header><div><span className="eyebrow">Live run monitor</span><h2>{task.title}</h2></div><div className="monitor-actions"><span className="health-pill"><StatusDot ok={monitor?.health === 'active' || monitor?.health === 'complete'} /> {humanState(monitor?.health || 'loading')}</span><button className="secondary compact" onClick={() => setShowLogs(!showLogs)}><Terminal size={13} /> {showLogs ? 'Hide terminal' : 'Live terminal'}</button>{task.state === 'paused' ? <button className="secondary compact" onClick={() => onResume(task)}><Play size={12} fill="currentColor" /> Resume</button> : running && task.target !== 'cloud' && ['queued', 'preflight', 'routing', 'running', 'recovering', 'reviewing', 'verifying'].includes(task.state) ? <button className="secondary compact" onClick={() => onPause(task)}><Pause size={12} /> Pause</button> : null}{stoppable && <button className="stop-button" onClick={() => onStop(task)}><Square size={12} fill="currentColor" /> {task.target === 'cloud' ? 'Stop Jules' : 'Stop'}</button>}</div></header>
    <div className="monitor-grid">
      <div><span>Phase</span><strong>{humanState(task.state)}</strong><small>{monitor?.currentAgent || 'system'}</small></div>
      <div><span>Elapsed</span><strong>{formatDuration(monitor?.elapsedMs || 0)}</strong><small>phase {formatDuration(Date.now() - Date.parse(monitor?.phaseStartedAt || task.createdAt))}</small></div>
      <div><span>Last activity</span><strong>{formatDuration(monitor?.inactiveMs || 0)} ago</strong><small>{monitor?.processAlive ? 'process alive' : 'no live process'}</small></div>
      <div><span>Review progress</span><strong>{monitor?.reviewCycle ? `Cycle ${monitor.reviewCycle}` : 'Not started'}</strong><small>{monitor?.repairAttempt || 0} repairs completed</small></div>
      <div><span>Project changes</span><strong>{monitor?.changedFiles.length ?? 0} files</strong><small>{monitor?.changedFiles.slice(0, 3).join(', ') || 'No uncommitted files'}</small></div>
      <div><span>Antigravity context</span><strong>{formatProviderContext(monitor?.providerTelemetry.antigravity)}</strong><small>{monitor?.providerTelemetry.antigravity?.context?.inputTokens?.toLocaleString() || 'No'} measured input tokens</small></div>
      <div><span>Codex context</span><strong>{formatProviderContext(monitor?.providerTelemetry.codex)}</strong><small>{monitor?.providerTelemetry.codex?.threadId ? 'fresh stage thread' : 'waiting for a Codex turn'}</small></div>
    </div>
    <p className="monitor-summary">{monitor?.summary || 'Loading deterministic run health…'}</p>
    {monitor?.progressDetail && <div className="latest-work"><strong>Current operation{monitor.providerState ? ` · Jules ${humanState(monitor.providerState)}` : ''}</strong><p>{monitor.progressDetail}</p>{monitor.nextAction && <small><strong>Next:</strong> {monitor.nextAction}</small>}</div>}
    {latestKnownWork && <div className="latest-work"><strong>Latest known work</strong><span>{latestKnownWork.agent} · {new Date(latestKnownWork.createdAt).toLocaleTimeString()}</span><p>{eventText(latestKnownWork)}</p></div>}
    {monitor?.stopReason && <div className="monitor-stop"><CircleAlert size={16} /><div><strong>Why execution paused</strong><p>{monitor.stopReason}</p></div></div>}
    {showLogs && (
      <div className="terminal-drawer">
        <header><strong>Subprocess Event Log</strong><span>{events.length} total events recorded</span></header>
        <div className="terminal-logs">
          {events.slice(-40).map((e) => `[${new Date(e.createdAt).toLocaleTimeString()}] [${e.agent.padEnd(12)}] ${e.type}: ${eventText(e)}`).join('\n') || 'No process events yet.'}
        </div>
      </div>
    )}
    <div className="monitor-detail">
      <div className="monitor-timeline"><header><strong>Recent timeline</strong><small>Live monitor checks every 5 seconds</small></header>{monitor && <div className="monitor-heartbeat"><time>{new Date().toLocaleTimeString()}</time><span className="agent-dot system" /><b>monitor</b><p>{monitor.processAlive ? `${monitor.currentAgent} owns the active work. ` : task.state === 'paused' ? 'The task is safely paused with no live process. ' : 'No process currently owns this task. '}{humanState(monitor.health)} · last activity {formatDuration(monitor.inactiveMs)} ago · {monitor.changedFiles.length} changed files.</p></div>}{recent.length ? recent.map((event) => <div key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><span className={`agent-dot ${event.agent}`} /><b>{event.agent}</b><p>{eventText(event)}</p></div>) : <small>Waiting for task events.</small>}</div>
      <div className="gemma-monitor"><div><strong>Ask Gemma about this run</strong><button className="secondary compact" onClick={onExplain} disabled={explanationBusy}>{explanationBusy ? 'Reading…' : 'Explain status'}</button></div><p>{explanation || 'Gemma answers from the run timeline, review findings, provider telemetry, errors, and sanitized Antigravity activity. Deterministic signals remain authoritative.'}</p><div className="gemma-question"><textarea value={question} onChange={(event) => onQuestion(event.target.value)} placeholder="Why did this enter a second repair cycle?" rows={3} /><button className="primary compact" onClick={onAsk} disabled={explanationBusy || !question.trim()}><Send size={14} /> Ask</button></div></div>
    </div>
  </article>;
}

export function Projects({ projects, activeId, busy, onBrowse, onActivate, onForget }: { projects: Project[]; activeId?: string; busy: boolean; onBrowse: () => void; onActivate: (project: Project) => void; onForget: (id: string) => void }) {
  return <section><PageHeader eyebrow="Project registry" title="Projects" subtitle="Each conversation, process, and Git operation is pinned to one canonical directory." action={<button className="primary" onClick={onBrowse} disabled={busy}><FolderOpen size={16} /> Add project</button>} />
    <div className="project-grid">{projects.map((project) => <article className={`project-card ${activeId === project.id ? 'active' : ''}`} key={project.id}><div className="project-icon"><FolderGit2 /></div><div><div className="project-title"><strong>{project.name}</strong>{activeId === project.id && <span className="pill">Active</span>}</div><p>{project.root}</p><div className="project-meta"><span>{project.gitRoot ? 'Git enabled' : 'No Git'}</span><span>Onboarding: {project.onboardingStatus}</span></div></div><div className="project-actions"><button className="secondary" onClick={() => onActivate(project)}>Open</button><button className="icon-button danger" title="Forget project" onClick={() => onForget(project.id)}><Trash2 size={16} /></button></div></article>)}</div>
    {!projects.length && <Empty icon={<FolderOpen />} title="No registered projects" text="Browse to a local codebase to initialize Orchestra and start a project-scoped conversation." />}
  </section>;
}

export { CheckpointsView } from '../features/checkpoints/CheckpointsView';
export { McpServersView } from '../features/mcp/McpServersView';
export { SettingsView } from '../features/settings/SettingsView';
export function TaskActivity({ task, events, models }: { task: Task; events: TaskEvent[]; models: Record<string, string> | null }) {
  const recent = events.filter((event) => ['agent.started', 'agent.output', 'agent.completed', 'task.paused', 'task.resumed', 'task.provider-recovery', 'task.model-takeover', 'task.takeover_local', 'mcp.capability', 'mcp.tool', 'verification.result', 'git.commit', 'git.push', 'cloud.activity', 'cloud.completed', 'cloud.reviewing', 'cloud.reviewed', 'cloud.repair_requested', 'cloud.cancelled', 'cloud.integrated', 'warning'].includes(event.type)).slice(-8);
  const rawPrimary = models?.primary === 'gemma' ? models.gemma : models?.antigravity;
  const primaryModel = rawPrimary ? (rawPrimary.includes('/') ? rawPrimary.split('/').pop() : rawPrimary) : '';
  return <div className="activity-card"><div className="activity-head"><RefreshCw className="spin" size={15} /><strong>{humanState(task.state)}</strong></div>{models && <small title={rawPrimary}>{primaryModel}{models.codex ? ` · ${models.codex}` : ''}</small>}<div className="activity-events">{recent.map((event) => <div key={event.id}><span className={`agent-dot ${event.agent}`} /> <strong>{event.agent}</strong><p>{eventText(event)}</p></div>)}</div></div>;
}

function eventText(event: TaskEvent) { const payload = event.payload; const next = typeof payload.nextAction === 'string' ? ` Next: ${payload.nextAction}` : typeof payload.resolution === 'string' ? ` Next: ${payload.resolution}` : ''; if (typeof payload.message === 'string') return `${payload.message}${next}`; if (typeof payload.text === 'string') return payload.text.slice(-900); if (typeof payload.summary === 'string') return payload.summary.slice(-900); if (event.type === 'cloud.activity' && payload.activity && typeof payload.activity === 'object') { const activity = payload.activity as Record<string, unknown>; return String(activity.description || activity.message || activity.type || 'Jules activity received.'); } if (event.type === 'task.state') return `Entered ${humanState(String(payload.state || 'unknown'))}.`; if (event.type === 'task.repair-progress') return `Automatic repair ${String(payload.attempt || '?')} completed; project diff ${payload.changed ? 'changed' : 'did not change'}.`; if (event.type === 'provider.telemetry') { const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {}; const total = Number(usage.total_tokens || usage.totalTokens || 0); const input = Number(usage.input_tokens || usage.inputTokens || 0); const output = Number(usage.output_tokens || usage.outputTokens || 0); const context = payload.context && typeof payload.context === 'object' ? payload.context as Record<string, unknown> : {}; const pressure = Number(context.usedPercent); return total ? `Turn usage: ${total.toLocaleString()} cumulative tokens (${input.toLocaleString()} input, ${output.toLocaleString()} output)${Number.isFinite(pressure) ? ` · latest context ${pressure.toFixed(1)}%` : ''}.` : payload.reroute ? 'Provider rerouted the selected model.' : 'Provider telemetry updated.'; } if (event.type === 'agent.started') return `Started ${String(payload.phase || payload.role || '')}${payload.cycle ? ` cycle ${String(payload.cycle)}` : ''}`.trim(); if (event.type === 'agent.completed') return `Completed ${String(payload.phase || payload.role || '')}`.trim(); if (event.type === 'git.remote') return `Connected origin to ${String(payload.remote || 'the requested remote')}.`; if (event.type === 'git.commit') return `Created commit ${String(payload.sha || '').slice(0, 8)}`; if (event.type === 'git.push') return payload.pushed ? 'Pushed to upstream' : String(payload.error || 'Push pending'); if (event.type === 'verification.result') { const results = Array.isArray(payload.results) ? payload.results as Array<Record<string, unknown>> : []; return results.length ? `Verification completed: ${results.map((item) => `${String(item.command || 'check')} ${Number(item.code) === 0 ? 'passed' : 'failed'}`).join('; ')}.` : 'Verification completed.'; } return humanState(event.type); }
function formatProviderContext(item?: ProviderUsage) { const percent = item?.context?.usedPercent; if (percent !== null && percent !== undefined) return `${percent.toFixed(1)}%`; const tokens = item?.context?.inputTokens ?? item?.context?.totalTokens; return tokens ? `${tokens.toLocaleString()} tokens` : 'Not measured'; }
