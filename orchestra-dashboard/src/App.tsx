import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Bot, CircleAlert, Cpu, FolderGit2, FolderOpen,
  Gauge, GitBranch, History, Hexagon, MemoryStick, MessageSquare, Plus, RefreshCw,
  Send, Server, Settings, ShieldCheck, Sparkles, Square, Terminal, Trash2, UploadCloud, Wrench, Zap,
} from 'lucide-react';

type View = 'dashboard' | 'projects' | 'tasks' | 'mcp' | 'settings';
type Project = { id: string; name: string; root: string; gitRoot: string | null; onboardingStatus: string; onboardingVersion: string | null; activeSessionId: string | null; updatedAt: string };
type Session = { id: string; projectId: string; title: string; antigravityConversationId: string | null; summary: string | null; summaryUpdatedAt: string | null; updatedAt: string };
type Message = { id: string; taskId: string | null; role: 'user' | 'assistant' | 'system'; agent: string; content: string; createdAt: string };
type Task = { id: string; projectId: string; sessionId: string; title: string; state: string; classification: string | null; models: string | null; result: string | null; error: string | null; commitSha: string | null; pushStatus: string | null; createdAt: string };
type TaskEvent = { id: number; taskId: string; agent: string; type: string; payload: Record<string, unknown>; createdAt: string };
type Stats = { cpu: { load: number; speed: string | null; name: string }; memory: { used: number; total: number; percent: number }; gpu: { load: number | null; name: string; temp: number | null }; timestamp: string };
type HealthItem = { available?: boolean; version?: string | null; modelAvailable?: boolean; models?: string[]; error?: string };
type Health = Record<string, HealthItem>;
type QuotaTierConfig = { antigravityModel: string; antigravityEffort: 'low' | 'medium' | 'high'; codexModel: string | null; codexEffort: 'low' | 'medium' | 'high' | null };
type QuotaPolicy = { tierAbove20: QuotaTierConfig; tier15to20: QuotaTierConfig; tier10to15: QuotaTierConfig; tier5to10: QuotaTierConfig; tierBelow5: QuotaTierConfig };
type SettingsData = { lmStudioBaseUrl: string; lmStudioModel: string; telemetryInterval: number; maxGlobalTasks: number; routingMode: string; quotaPolicy: QuotaPolicy };
type ProviderUsage = { available: boolean; source?: string; reason?: string; model?: string; stale?: boolean; agentState?: string; threadId?: string; context?: { usedPercent: number | null; remainingPercent: number | null; windowTokens: number | null; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }; quotas?: Array<{ id: string; usedPercent: number | null; remainingPercent: number | null; resetsAt: string | null }> };
type McpAgentStatus = { configured: boolean; enabled: boolean; available: boolean; access: 'full' | 'read-only' | 'none'; endpoint: string | null; reason: string | null };
type McpStatus = { checkedAt: string; server: { name: string; version: string | null; operational: boolean; endpoint: string | null; toolCount: number; latencyMs: number | null; reason: string | null }; agents: Record<'antigravity' | 'codex' | 'gemma', McpAgentStatus> };
type McpServerRecord = {
  id: string;
  name: string;
  enabled: boolean;
  transportType: 'http' | 'stdio';
  endpoint: string | null;
  command: string | null;
  args: string[];
  operational: boolean;
  toolCount: number;
  tools: string[];
  latencyMs: number | null;
  models: { antigravity: boolean; codex: boolean; gemma: boolean };
  sources: { antigravityGlobal: boolean; antigravityLocal: boolean; codex: boolean };
  reason: string | null;
};
type RunMonitor = { taskId: string; state: string; health: 'active' | 'waiting' | 'possibly_stalled' | 'needs_attention' | 'complete' | 'failed'; currentAgent: string; phaseStartedAt: string; lastActivityAt: string; elapsedMs: number; inactiveMs: number; processAlive: boolean; reviewCycle: number; repairAttempt: number; changedFiles: string[]; summary: string; stopReason: string | null; providerTelemetry: Record<string, ProviderUsage>; providerActivity: Array<Record<string, unknown>> };

const eventNames = ['task.state', 'task.error', 'task.recovery', 'task.recovery-required', 'task.review-disputed', 'task.steer', 'task.repair-progress', 'task.provider-recovery', 'task.model-takeover', 'agent.started', 'agent.output', 'agent.completed', 'provider.telemetry', 'routing.adjustment', 'mcp.capability', 'mcp.tool', 'verification.result', 'git.baseline-required', 'git.remote', 'git.commit', 'git.push', 'project.onboarding', 'warning'];
const terminalStates = new Set(['completed', 'completed_unpushed', 'failed', 'cancelled', 'baseline_required', 'recovery_required', 'review_disputed']);

function App() {
  const [token, setToken] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [activity, setActivity] = useState<TaskEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health>({});
  const [usage, setUsage] = useState<Record<string, ProviderUsage>>({});
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [input, setInput] = useState('');
  const [executionMode, setExecutionMode] = useState<'orchestra' | 'direct'>('orchestra');
  const [directAgent, setDirectAgent] = useState<'gemma' | 'antigravity' | 'codex'>('gemma');
  const [steerInput, setSteerInput] = useState('');
  const [steerOpen, setSteerOpen] = useState(false);
  const [steerSuggestion, setSteerSuggestion] = useState<string | null>(null);
  const [steerSuggesting, setSteerSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scopeWarning, setScopeWarning] = useState('');
  const [monitor, setMonitor] = useState<RunMonitor | null>(null);
  const [monitorExplanation, setMonitorExplanation] = useState('');
  const [monitorQuestion, setMonitorQuestion] = useState('');
  const [monitorBusy, setMonitorBusy] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const tokenRef = useRef('');
  const recoveryRequestsRef = useRef(new Set<string>());
  const monitoredTaskId = activeTask?.id;

  const authenticatedFetch = useCallback(async (path: string, options: RequestInit = {}, overrideToken?: string) => {
    const request = (activeToken: string) => fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(activeToken ? { 'X-Orchestra-Token': activeToken } : {}), ...options.headers },
      });
    let response = await request(tokenRef.current || overrideToken || '');
    if (response.status === 403) {
      const bootstrapResponse = await fetch('/api/bootstrap', { cache: 'no-store' });
      if (bootstrapResponse.ok) {
        const bootstrap = await bootstrapResponse.json();
        if (typeof bootstrap.token === 'string' && bootstrap.token) {
          tokenRef.current = bootstrap.token;
          setToken(bootstrap.token);
          response = await request(bootstrap.token);
        }
      }
    }
    return response;
  }, []);

  const api = useCallback(async <T,>(path: string, options: RequestInit = {}, overrideToken?: string): Promise<T> => {
    const response = await authenticatedFetch(path, options, overrideToken);
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
    return body as T;
  }, [authenticatedFetch]);

  const reload = useCallback(async (projectId?: string) => {
    const [projectList, taskList] = await Promise.all([
      api<Project[]>('/api/projects'),
      api<Task[]>(`/api/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    ]);
    setProjects(projectList); setTasks(taskList);
    if (projectId) setProject(projectList.find((item) => item.id === projectId) || null);
  }, [api]);

  const fetchMcpServers = useCallback(async (force = false) => {
    try {
      const data = await api<McpServerRecord[]>(`/api/mcp/servers${force ? '?force=true' : ''}`);
      setMcpServers(data);
    } catch { /* ignore */ }
  }, [api]);

  async function toggleServer(id: string, enabled: boolean) {
    setMcpBusy(true);
    try {
      await api<{ ok: boolean; server: McpServerRecord }>(`/api/mcp/servers/${id}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      await Promise.all([
        fetchMcpServers(true),
        api<McpStatus>('/api/telemetry/mcp').then(setMcp).catch(() => undefined),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMcpBusy(false);
    }
  }

  useEffect(() => {
    void fetch('/api/bootstrap').then(async (response) => {
      if (!response.ok) throw new Error('Backend bootstrap failed.');
      const data = await response.json();
      tokenRef.current = data.token;
      setToken(data.token); setProjects(data.projects); setTasks(data.tasks); setHealth(data.health); setSettings(data.settings);
      if (data.projects[0]) await activateProject(data.projects[0], data.token);
      void fetchMcpServers();
    }).catch((reason) => setError(reason.message));
    return () => streamRef.current?.close();
    // Initial bootstrap must run only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchMcpServers]);

  useEffect(() => {
    if (!token || !settings) return;
    const update = () => Promise.all([api<Stats>('/api/stats'), api<Health>('/api/health'), api<typeof usage>('/api/usage'), api<McpStatus>('/api/mcp/status'), fetchMcpServers()])
      .then(([nextStats, nextHealth, nextUsage, nextMcp]) => { setStats(nextStats); setHealth(nextHealth); setUsage(nextUsage); setMcp(nextMcp); })
      .catch((reason) => setError(reason.message));
    void update();
    const timer = setInterval(update, settings.telemetryInterval);
    return () => clearInterval(timer);
  }, [api, fetchMcpServers, settings, token]);

  useEffect(() => {
    if (!monitoredTaskId) { setMonitor(null); setMonitorExplanation(''); return; }
    let cancelled = false;
    const update = () => api<RunMonitor>(`/api/tasks/${monitoredTaskId}/monitor`).then((value) => { if (!cancelled) setMonitor(value); }).catch(() => undefined);
    void update();
    const timer = setInterval(update, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [monitoredTaskId, api]);

  useEffect(() => {
    const container = messagesRef.current;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [messages, activity]);

  async function activateProject(nextProject: Project, overrideToken?: string) {
    try {
      setBusy(true); setError('');
      const data = await api<{ project: Project; sessions: Session[]; activeSession: Session; scope?: { warning?: string } }>(`/api/projects/${nextProject.id}/activate`, { method: 'POST', body: '{}' }, overrideToken);
      setProject(data.project); setSessions(data.sessions); setSession(data.activeSession); setScopeWarning(data.scope?.warning || '');
      const projectTasks = await api<Task[]>(`/api/tasks?projectId=${nextProject.id}`, {}, overrideToken);
      const projectActiveTask = await api<Task | null>(`/api/projects/${nextProject.id}/active-task`, {}, overrideToken);
      setTasks(projectTasks);
      const visibleSession = projectActiveTask ? data.sessions.find((item) => item.id === projectActiveTask.sessionId) || data.activeSession : data.activeSession;
      setSession(visibleSession);
      setMessages(await api<Message[]>(`/api/sessions/${visibleSession.id}/messages`, {}, overrideToken));
      setActivity([]);
      const sessionTasks = projectTasks.filter((task) => task.sessionId === visibleSession.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const newestTask = sessionTasks[0] || null;
      const restored = projectActiveTask || (newestTask && !terminalStates.has(newestTask.state) ? newestTask : null);
      setActiveTask(restored);
      if (restored) watchTask(restored.id);
      setView('dashboard');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function browseProject() {
    try {
      setBusy(true); setError('');
      const picked = await api<{ path: string }>('/api/projects/pick', { method: 'POST', body: '{}' });
      const created = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ path: picked.path }) });
      await reload(); await activateProject(created.project);
    } catch (reason) { if (!String(reason).includes('cancelled')) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function newSession() {
    if (!project) return;
    try {
      const created = await api<Session>(`/api/projects/${project.id}/sessions`, { method: 'POST', body: JSON.stringify({ title: 'New conversation' }) });
      setSessions((current) => [created, ...current]); setSession(created); setMessages([]); setActivity([]); await restoreProjectTask(project.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function selectSession(next: Session) {
    await api(`/api/sessions/${next.id}/activate`, { method: 'POST', body: '{}' });
    setSession(next); setMessages(await api<Message[]>(`/api/sessions/${next.id}/messages`)); setActivity([]); await restoreProjectTask(next.projectId);
  }

  async function restoreProjectTask(projectId: string) {
    const running = await api<Task | null>(`/api/projects/${projectId}/active-task`);
    const projectTasks = await api<Task[]>(`/api/tasks?projectId=${projectId}`);
    const sessionTasks = projectTasks.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const newestTask = sessionTasks[0] || null;
    const latest = running || (newestTask && !terminalStates.has(newestTask.state) ? newestTask : null);
    setActiveTask(latest);
    if (latest) watchTask(latest.id);
  }

  async function send() {
    if (!session || scopeWarning || !input.trim() || activeTask && (!terminalStates.has(activeTask.state) || activeTask.state === 'recovery_required')) return;
    const prompt = input.trim(); setInput(''); setError('');
    try {
      const created = await api<Task>(`/api/sessions/${session.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ prompt, mode: executionMode, directAgent }),
      });
      setMessages((current) => [...current, { id: crypto.randomUUID(), taskId: created.id, role: 'user', agent: 'system', content: prompt, createdAt: new Date().toISOString() }]);
      setTasks((current) => [created, ...current]); setActiveTask(created); setActivity([]); watchTask(created.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  function watchTask(taskId: string) {
    streamRef.current?.close();
    const stream = new EventSource(`/api/tasks/${taskId}/events`);
    streamRef.current = stream;
    const receive = (raw: Event) => {
      const event = JSON.parse((raw as MessageEvent).data) as TaskEvent;
      setActivity((current) => [...current.slice(-199), event]);
      if (event.type === 'task.state') {
        const state = String(event.payload.state);
        setActiveTask((current) => current ? { ...current, state, result: typeof event.payload.result === 'string' ? event.payload.result : current.result } : current);
        if (terminalStates.has(state)) {
          stream.close();
          void api<Task>(`/api/tasks/${taskId}`).then((latest) => {
            void api<Message[]>(`/api/sessions/${latest.sessionId}/messages`).then(setMessages);
            void reload(latest.projectId);
          });
        }
      }
      if (event.type === 'task.error') setError(String(event.payload.message || 'Task failed.'));
    };
    for (const name of eventNames) stream.addEventListener(name, receive);
    stream.onerror = () => { if (stream.readyState === EventSource.CLOSED) setError('Task event stream disconnected. Reload to restore it.'); };
  }

  async function resolveBaseline() {
    if (!project || !activeTask) return;
    try {
      await api(`/api/projects/${project.id}/baseline`, { method: 'POST', body: JSON.stringify({ taskId: activeTask.id }) });
      setActiveTask({ ...activeTask, state: 'queued' }); watchTask(activeTask.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function cancelTask(task = activeTask) {
    if (!task) return;
    await api(`/api/tasks/${task.id}/cancel`, { method: 'POST', body: '{}' });
    const cancelled = { ...task, state: 'cancelled' };
    setActiveTask((current) => current?.id === task.id ? cancelled : current);
    setTasks((current) => current.map((item) => item.id === task.id ? cancelled : item));
  }
  async function recoverTask(task: Task) {
    if (recoveryRequestsRef.current.has(task.id)) return;
    recoveryRequestsRef.current.add(task.id);
    const recovering = { ...task, state: 'recovering', error: null };
    setActiveTask((current) => current?.id === task.id ? recovering : current);
    setTasks((current) => current.map((item) => item.id === task.id ? recovering : item));
    setActivity([]); watchTask(task.id); setView('dashboard');
    try {
      setError('');
      await api(`/api/tasks/${task.id}/recover`, { method: 'POST', body: '{}' });
    } catch (reason) {
      try {
        const latest = await api<Task>(`/api/tasks/${task.id}`);
        setActiveTask((current) => current?.id === task.id ? latest : current);
        setTasks((current) => current.map((item) => item.id === task.id ? latest : item));
      } catch { /* Keep the original request error. */ }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { recoveryRequestsRef.current.delete(task.id); }
  }
  async function retryTask(task: Task) {
    try {
      setError('');
      await api(`/api/tasks/${task.id}/retry`, { method: 'POST', body: '{}' });
      const retrying = { ...task, state: 'queued', error: null };
      const retrySession = sessions.find((item) => item.id === task.sessionId);
      if (retrySession) { setSession(retrySession); setMessages(await api<Message[]>(`/api/sessions/${retrySession.id}/messages`)); }
      setActiveTask(retrying); setActivity([]); watchTask(task.id); setView('dashboard');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function retryPush(task: Task) { await api(`/api/tasks/${task.id}/retry-push`, { method: 'POST', body: '{}' }); if (project) await reload(project.id); }
  async function approveDisputed(task: Task) {
    try {
      setBusy(true); setError('');
      const updated = await api<Task>(`/api/tasks/${task.id}/approve-disputed`, { method: 'POST', body: '{}' });
      setActiveTask(updated);
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
      if (session) setMessages(await api<Message[]>(`/api/sessions/${session.id}/messages`));
      if (project) await reload(project.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function steerDisputed(task: Task) {
    if (!steerInput.trim()) return;
    try {
      setBusy(true); setError('');
      const updated = await api<Task>(`/api/tasks/${task.id}/steer-disputed`, { method: 'POST', body: JSON.stringify({ guidance: steerInput.trim() }) });
      setSteerInput(''); setSteerOpen(false);
      setActiveTask(updated);
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
      setActivity([]); watchTask(task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function explainMonitor() {
    if (!activeTask || monitorBusy) return;
    try {
      setMonitorBusy(true);
      const value = await api<{ explanation: string }>(`/api/tasks/${activeTask.id}/monitor/explain`, { method: 'POST', body: '{}' });
      setMonitorExplanation(value.explanation);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setMonitorBusy(false); }
  }
  async function askMonitor() {
    if (!activeTask || monitorBusy || !monitorQuestion.trim()) return;
    try {
      setMonitorBusy(true);
      const value = await api<{ answer: string }>(`/api/tasks/${activeTask.id}/monitor/ask`, { method: 'POST', body: JSON.stringify({ question: monitorQuestion.trim() }) });
      setMonitorExplanation(value.answer);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setMonitorBusy(false); }
  }
  async function forgetProject(id: string) { await api(`/api/projects/${id}`, { method: 'DELETE' }); if (project?.id === id) { setProject(null); setSession(null); setMessages([]); } await reload(); }

  const currentModels = useMemo(() => {
    try { return activeTask?.models ? JSON.parse(activeTask.models) : null; } catch { return null; }
  }, [activeTask]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Hexagon size={28} fill="currentColor" /><div><strong>ORCHESTRA</strong><span>Command Center</span></div></div>
        <nav>
          <NavButton active={view === 'dashboard'} icon={<Gauge />} label="Dashboard" onClick={() => setView('dashboard')} />
          <NavButton active={view === 'projects'} icon={<FolderGit2 />} label="Projects" onClick={() => setView('projects')} />
          <NavButton active={view === 'tasks'} icon={<History />} label="Task history" onClick={() => setView('tasks')} />
          <NavButton active={view === 'mcp'} icon={<Server />} label="MCP Servers" onClick={() => setView('mcp')} />
          <NavButton active={view === 'settings'} icon={<Settings />} label="Settings" onClick={() => setView('settings')} />
        </nav>
        <div className="sidebar-project">
          <span className="eyebrow">Active project</span>
          {project ? <><strong>{project.name}</strong><span title={project.root}>{project.root}</span><small><GitBranch size={12} /> {project.gitRoot ? 'Git repository' : 'Git disabled'}</small></> : <span>No project selected</span>}
          <button className="secondary full" onClick={browseProject} disabled={busy}><FolderOpen size={15} /> Browse project</button>
        </div>
      </aside>

      <main className="content">
        {error && <div className="error-banner"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
        {scopeWarning && <div className="error-banner warning"><CircleAlert size={18} /><span>{scopeWarning}</span></div>}
        {view === 'dashboard' && <Dashboard stats={stats} health={health} usage={usage} mcp={mcp} project={project} tasks={tasks} activeTask={activeTask} monitor={monitor} events={activity} explanation={monitorExplanation} explanationBusy={monitorBusy} question={monitorQuestion} onQuestion={setMonitorQuestion} onAsk={askMonitor} onExplain={explainMonitor} onStop={cancelTask} onApproveDisputed={approveDisputed} onSteerDisputed={steerDisputed} />}
        {view === 'projects' && <Projects projects={projects} activeId={project?.id} busy={busy} onBrowse={browseProject} onActivate={activateProject} onForget={forgetProject} />}
        {view === 'tasks' && <Tasks tasks={tasks} projects={projects} onRetryPush={retryPush} onRecover={recoverTask} onRetryTask={retryTask} onStop={cancelTask} onApproveDisputed={approveDisputed} />}
        {view === 'mcp' && <McpServersView servers={mcpServers} busy={mcpBusy} onToggle={toggleServer} onRefresh={() => fetchMcpServers(true)} />}
        {view === 'settings' && settings && <SettingsView settings={settings} health={health} onSave={async (value) => setSettings(await api<SettingsData>('/api/settings', { method: 'PATCH', body: JSON.stringify(value) }))} />}
      </main>

      <aside className="chat-panel">
        <header className="chat-header">
          <div><span className="eyebrow">Project-scoped workspace</span><strong><MessageSquare size={17} /> Tri-Agent Chat</strong></div>
          <button className="icon-button" title="New conversation" onClick={newSession} disabled={!project}><Plus size={18} /></button>
        </header>
        <div className="session-row">
          <select value={session?.id || ''} onChange={(event) => { const next = sessions.find((item) => item.id === event.target.value); if (next) void selectSession(next); }} disabled={!sessions.length}>
            {!sessions.length && <option>Select a project</option>}
            {sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </div>
        <div className="messages" ref={messagesRef}>
          {!project && <Empty icon={<FolderOpen />} title="Choose a project" text="Every conversation and agent process is pinned to a selected directory." />}
          {project && messages.length === 0 && <Empty icon={<Bot />} title={`Ready in ${project.name}`} text="Describe what you want done. Model selection and agent delegation are automatic." />}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-header">
                <span>{message.role === 'user' ? 'You' : message.agent}</span>
                {message.role === 'assistant' && message.content && (
                  <button
                    type="button"
                    className="action-link"
                    onClick={() => {
                      setExecutionMode('orchestra');
                      setInput(`Implement the following plan / feature proposal:\n\n${message.content}`);
                    }}
                    title="Promote this answer into an orchestrated multi-agent task"
                  >
                    <Wrench size={11} /> Implement with Orchestra
                  </button>
                )}
              </div>
              <p>{message.content}</p>
            </article>
          ))}
          {activeTask && !terminalStates.has(activeTask.state) && <TaskActivity task={activeTask} events={activity} models={currentModels} />}
          {activeTask?.state === 'baseline_required' && <div className="baseline-card"><CircleAlert /><strong>External changes detected</strong><p>Uncommitted modifications were detected from outside Orchestra. Gemma can review, summarize in HANDOFF.md, and commit them automatically before this task starts.</p><button className="primary" onClick={resolveBaseline}>Auto-commit baseline with Gemma</button></div>}
          {activeTask?.state === 'recovery_required' && <div className="baseline-card"><CircleAlert /><strong>Partial task changes preserved</strong><p>Resume this same task so Antigravity can finish and Codex can review the complete change set. These files will not be committed as a separate baseline.</p><button className="primary" onClick={() => recoverTask(activeTask)}>Resume and review</button></div>}
          {activeTask?.state === 'review_disputed' && (
            <div className="baseline-card disputed-card">
              <CircleAlert />
              <strong>Review Consensus Not Reached</strong>
              <p>Automatic repair reached its limit without full consensus. You can approve and commit the preserved diff directly, or steer the next repair attempt.</p>
              <div className="dispute-actions">
                <button className="primary" onClick={() => approveDisputed(activeTask)} disabled={busy}>Approve & Commit Diff</button>
                <button className="secondary" onClick={() => setSteerOpen(!steerOpen)} disabled={busy}>{steerOpen ? 'Close guidance' : 'Provide guidance & retry'}</button>
              </div>               {steerOpen && (
                <div className="steer-box">
                  {(() => {
                    const lastReviewEvent = activity.findLast((e) => e.type === 'agent.completed' && (e.payload as Record<string, unknown>).role === 'review');
                    const lastReviewSummary = typeof lastReviewEvent?.payload?.summary === 'string' ? lastReviewEvent.payload.summary : null;
                    return lastReviewSummary ? (
                      <details className="steer-findings" open>
                        <summary>Latest Codex Review Blocker(s)</summary>
                        <pre>{lastReviewSummary}</pre>
                      </details>
                    ) : null;
                  })()}
                  {steerSuggestion ? (
                    <div className="steer-suggestion-box">
                      <div className="steer-suggestion-header">
                        <span className="steer-suggestion-title"><Sparkles size={13} /> AI Suggested Next Step:</span>
                        <button type="button" className="action-link" onClick={() => setSteerInput(steerSuggestion)}>Use This Suggestion</button>
                      </div>
                      <p>{steerSuggestion}</p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={async () => {
                        setSteerSuggesting(true);
                        try {
                          const res = await api<{ suggestion: string }>(`/api/tasks/${activeTask.id}/suggest-steering`, { method: 'POST' });
                          if (res?.suggestion) setSteerSuggestion(res.suggestion);
                        } catch (err) {
                          console.error(err);
                        } finally {
                          setSteerSuggesting(false);
                        }
                      }}
                      disabled={steerSuggesting}
                    >
                      <Sparkles size={13} /> {steerSuggesting ? 'Analyzing blockers & drafting tip…' : 'Generate AI Steering Tip'}
                    </button>
                  )}
                  <textarea value={steerInput} onChange={(e) => setSteerInput(e.target.value)} placeholder="Specify exact changes or approaches Antigravity should take..." rows={3} autoFocus />
                  <button className="primary compact" onClick={() => steerDisputed(activeTask)} disabled={busy || !steerInput.trim()}><Send size={14} /> Send Guidance & Resume Repairs</button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="composer">
          {activeTask && !terminalStates.has(activeTask.state) && activeTask.state !== 'baseline_required' && <button className="stop-button" onClick={() => void cancelTask()}><Square size={12} fill="currentColor" /> Stop task</button>}
          <div className="mode-selector">
            <button
              type="button"
              className={`mode-pill ${executionMode === 'orchestra' ? 'active' : ''}`}
              onClick={() => setExecutionMode('orchestra')}
              title="Tri-Agent Workflow: Full planning, implementation, Codex review, verification, and atomic Git commit"
            >
              <Bot size={13} /> Orchestra
            </button>
            <button
              type="button"
              className={`mode-pill ${executionMode === 'direct' && directAgent === 'gemma' ? 'active' : ''}`}
              onClick={() => { setExecutionMode('direct'); setDirectAgent('gemma'); }}
              title="Direct Solo Chat with Local Gemma (fast, 0 cloud tokens)"
            >
              <Zap size={13} /> Gemma
            </button>
            <button
              type="button"
              className={`mode-pill ${executionMode === 'direct' && directAgent === 'codex' ? 'active' : ''}`}
              onClick={() => { setExecutionMode('direct'); setDirectAgent('codex'); }}
              title="Direct Solo Consultation with Codex (GPT-5.6 + JetBrains Rider MCP inspection)"
            >
              <ShieldCheck size={13} /> Codex
            </button>
            <button
              type="button"
              className={`mode-pill ${executionMode === 'direct' && directAgent === 'antigravity' ? 'active' : ''}`}
              onClick={() => { setExecutionMode('direct'); setDirectAgent('antigravity'); }}
              title="Direct Solo Chat with Antigravity (Gemini 1M Context read-only inspection)"
            >
              <Sparkles size={13} /> Antigravity
            </button>
          </div>
          <div className="composer-box">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
              placeholder={
                scopeWarning
                  ? 'Select a specific repository before starting a task…'
                  : executionMode === 'direct'
                  ? directAgent === 'gemma'
                    ? 'Ask Local Gemma directly (fast Q&A, 0 tokens, no git commits)…'
                    : directAgent === 'codex'
                    ? 'Consult Codex directly (GPT-5.6 + Rider semantic inspection, no file changes)…'
                    : 'Ask Antigravity directly (Gemini 1M context, read-only)…'
                  : project
                  ? `Ask Orchestra to work in ${project.name} (full tri-agent build & review)…`
                  : 'Select a project first…'
              }
              disabled={!session || Boolean(scopeWarning)}
              rows={3}
            />
            <button className="send-button" onClick={send} disabled={!session || Boolean(scopeWarning) || !input.trim() || Boolean(activeTask && (!terminalStates.has(activeTask.state) || activeTask.state === 'recovery_required' || activeTask.state === 'review_disputed'))}><Send size={17} /></button>
          </div>
          <small>
            {executionMode === 'direct' ? (
              <span><strong>Solo Chat Mode:</strong> Direct conversational response without multi-agent review or Git commits.</span>
            ) : (
              <span><strong>Orchestra Mode:</strong> Full planning, Antigravity coding, Codex review, verification, and Git commits.</span>
            )}
          </small>
        </div>
      </aside>
    </div>
  );
}

function Dashboard({ stats, health, usage, mcp, project, tasks, activeTask, monitor, events, explanation, explanationBusy, question, onQuestion, onAsk, onExplain, onStop, onApproveDisputed, onSteerDisputed }: { stats: Stats | null; health: Health; usage: Record<string, ProviderUsage>; mcp: McpStatus | null; project: Project | null; tasks: Task[]; activeTask: Task | null; monitor: RunMonitor | null; events: TaskEvent[]; explanation: string; explanationBusy: boolean; question: string; onQuestion: (value: string) => void; onAsk: () => void; onExplain: () => void; onStop: () => void; onApproveDisputed: (task: Task) => void; onSteerDisputed: (task: Task) => void }) {
  const running = tasks.filter((task) => !terminalStates.has(task.state)).length;
  return <section><PageHeader eyebrow="Local system and agent status" title="Command Center" subtitle={project ? `Working directory: ${project.root}` : 'Select a project to begin.'} />
    {activeTask && <LiveRunMonitor task={activeTask} monitor={monitor} events={events} explanation={explanation} explanationBusy={explanationBusy} question={question} onQuestion={onQuestion} onAsk={onAsk} onExplain={onExplain} onStop={onStop} onApproveDisputed={onApproveDisputed} onSteerDisputed={onSteerDisputed} />}
    <div className="metrics-grid">
      <Metric icon={<Cpu />} label="CPU" value={`${stats?.cpu.load ?? 0}%`} detail={stats?.cpu.speed || 'Unavailable'} percent={stats?.cpu.load ?? 0} color="blue" />
      <Metric icon={<MemoryStick />} label="Memory" value={`${stats?.memory.percent ?? 0}%`} detail={stats ? `${stats.memory.used} / ${stats.memory.total} GB` : 'Loading'} percent={stats?.memory.percent ?? 0} color="cyan" />
      <Metric icon={<Activity />} label="GPU" value={stats?.gpu.load === null || stats?.gpu.load === undefined ? 'N/A' : `${stats.gpu.load}%`} detail={stats ? `${stats.gpu.temp === null ? 'Temp N/A' : `${stats.gpu.temp}°C`} · ${stats.gpu.name}` : 'Loading'} percent={stats?.gpu.load ?? 0} color="green" />
    </div>
    <div className="two-column">
      <Card title="Agent services" icon={<Server />}><div className="service-list">{Object.entries(health).map(([name, item]) => <div key={name}><StatusDot ok={item.available !== false && (item.modelAvailable ?? true)} /><span>{name}</span><small>{item.version || (item.modelAvailable === false ? 'Model missing' : item.available === false ? 'Unavailable' : 'Ready')}</small></div>)}</div></Card>
      <Card title="Provider usage" icon={<Zap />}><div className="usage-list">{['antigravity', 'codex'].map((name) => { const item = usage[name]; const context = item?.context?.usedPercent; const remaining = item?.quotas?.map((bucket) => bucket.remainingPercent).filter((value): value is number => value !== null).sort((a, b) => a - b)[0]; const signals = [remaining !== undefined ? `${remaining.toFixed(0)}% quota left` : null, context !== null && context !== undefined ? `${context.toFixed(0)}% context` : null].filter(Boolean); return <div key={name}><strong>{name}</strong><span className={item?.available ? '' : 'unavailable'}>{item?.available ? signals.join(' · ') || 'Connected' : 'Unavailable'}</span><small>{item?.available ? `${item.model || item.source || 'Verified provider source'}${item.stale ? ' · stale snapshot' : ''}` : item?.reason || 'Waiting for a trustworthy provider source.'}</small></div>; })}</div></Card>
    </div>
    <div className="mcp-panel"><Card title="Rider MCP" icon={<Terminal />}>
      <div className="mcp-server"><StatusDot ok={mcp?.server.operational === true} /><div><strong>{mcp?.server.name || 'Checking Rider MCP…'}</strong><small>{mcp?.server.operational ? `${mcp.server.toolCount} tools · v${mcp.server.version || 'unknown'} · ${mcp.server.latencyMs ?? '?'} ms` : mcp?.server.reason || 'Waiting for the first protocol check.'}</small><code>{mcp?.server.endpoint || 'No endpoint discovered'}</code></div></div>
      <div className="mcp-agent-grid">{(['antigravity', 'codex', 'gemma'] as const).map((agent) => { const status = mcp?.agents[agent]; return <div key={agent}><StatusDot ok={status?.available === true} /><strong>{agent}</strong><span>{status?.available ? `${status.access} access` : 'unavailable'}</span><small>{status?.available ? agent === 'gemma' ? 'Orchestra read-only tool bridge ready' : 'Configured and endpoint operational' : status?.reason || 'Checking configuration…'}</small></div>; })}</div>
    </Card></div>
    <div className="summary-strip"><div><strong>{running}</strong><span>Active tasks</span></div><div><strong>{tasks.filter((task) => task.state === 'completed').length}</strong><span>Completed</span></div><div><strong>{tasks.filter((task) => task.state === 'completed_unpushed').length}</strong><span>Awaiting push</span></div></div>
  </section>;
}

function LiveRunMonitor({ task, monitor, events, explanation, explanationBusy, question, onQuestion, onAsk, onExplain, onStop, onApproveDisputed, onSteerDisputed }: { task: Task; monitor: RunMonitor | null; events: TaskEvent[]; explanation: string; explanationBusy: boolean; question: string; onQuestion: (value: string) => void; onAsk: () => void; onExplain: () => void; onStop: () => void; onApproveDisputed: (task: Task) => void; onSteerDisputed: (task: Task) => void }) {
  const [showLogs, setShowLogs] = useState(false);
  const recent = events.filter((event) => ['task.state', 'task.repair-progress', 'task.provider-recovery', 'task.model-takeover', 'task.review-disputed', 'task.steer', 'routing.adjustment', 'mcp.capability', 'mcp.tool', 'agent.started', 'agent.output', 'agent.completed', 'provider.telemetry', 'verification.result', 'git.commit', 'git.push'].includes(event.type)).slice(-25).reverse();
  const latestKnownWork = recent.find((event) => event.type === 'agent.output' || event.type === 'agent.completed' || event.type === 'task.provider-recovery' || event.type === 'task.model-takeover');
  const running = !terminalStates.has(task.state);
  return <article className={`live-monitor health-${monitor?.health || 'waiting'}`}>
    <header><div><span className="eyebrow">Live run monitor</span><h2>{task.title}</h2></div><div className="monitor-actions"><span className="health-pill"><StatusDot ok={monitor?.health === 'active' || monitor?.health === 'complete'} /> {humanState(monitor?.health || 'loading')}</span><button className="secondary compact" onClick={() => setShowLogs(!showLogs)}><Terminal size={13} /> {showLogs ? 'Hide terminal' : 'Live terminal'}</button>{running && <button className="stop-button" onClick={onStop}><Square size={12} fill="currentColor" /> Stop</button>}</div></header>
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
    {task.state === 'review_disputed' && (
      <div className="monitor-stop">
        <CircleAlert size={16} />
        <div style={{ width: '100%' }}>
          <strong>Review Consensus Dispute</strong>
          <p>Repair limit reached (2 cycles). You can approve and finalize the preserved diff, or steer Antigravity with custom instructions.</p>
          <div className="dispute-actions" style={{ marginTop: '8px' }}>
            <button className="primary compact" onClick={() => onApproveDisputed(task)}>Approve & Commit Diff</button>
            <button className="secondary compact" onClick={() => onSteerDisputed(task)}>Provide Guidance</button>
          </div>
        </div>
      </div>
    )}
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
      <div className="monitor-timeline"><header><strong>Recent timeline</strong><small>Live monitor checks every 5 seconds</small></header>{monitor && <div className="monitor-heartbeat"><time>{new Date().toLocaleTimeString()}</time><span className="agent-dot system" /><b>monitor</b><p>{monitor.processAlive ? `${monitor.currentAgent} process is alive. ` : 'No process currently owns this task. '}{humanState(monitor.health)} · last agent event {formatDuration(monitor.inactiveMs)} ago · {monitor.changedFiles.length} changed files.</p></div>}{recent.length ? recent.map((event) => <div key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><span className={`agent-dot ${event.agent}`} /><b>{event.agent}</b><p>{eventText(event)}</p></div>) : <small>Waiting for task events.</small>}</div>
      <div className="gemma-monitor"><div><strong>Ask Gemma about this run</strong><button className="secondary compact" onClick={onExplain} disabled={explanationBusy}>{explanationBusy ? 'Reading…' : 'Explain status'}</button></div><p>{explanation || 'Gemma answers from the run timeline, review findings, provider telemetry, errors, and sanitized Antigravity activity. Deterministic signals remain authoritative.'}</p><div className="gemma-question"><textarea value={question} onChange={(event) => onQuestion(event.target.value)} placeholder="Why did this enter a second repair cycle?" rows={3} /><button className="primary compact" onClick={onAsk} disabled={explanationBusy || !question.trim()}><Send size={14} /> Ask</button></div></div>
    </div>
  </article>;
}

function Projects({ projects, activeId, busy, onBrowse, onActivate, onForget }: { projects: Project[]; activeId?: string; busy: boolean; onBrowse: () => void; onActivate: (project: Project) => void; onForget: (id: string) => void }) {
  return <section><PageHeader eyebrow="Project registry" title="Projects" subtitle="Each conversation, process, and Git operation is pinned to one canonical directory." action={<button className="primary" onClick={onBrowse} disabled={busy}><FolderOpen size={16} /> Add project</button>} />
    <div className="project-grid">{projects.map((project) => <article className={`project-card ${activeId === project.id ? 'active' : ''}`} key={project.id}><div className="project-icon"><FolderGit2 /></div><div><div className="project-title"><strong>{project.name}</strong>{activeId === project.id && <span className="pill">Active</span>}</div><p>{project.root}</p><div className="project-meta"><span>{project.gitRoot ? 'Git enabled' : 'No Git'}</span><span>Onboarding: {project.onboardingStatus}</span></div></div><div className="project-actions"><button className="secondary" onClick={() => onActivate(project)}>Open</button><button className="icon-button danger" title="Forget project" onClick={() => onForget(project.id)}><Trash2 size={16} /></button></div></article>)}</div>
    {!projects.length && <Empty icon={<FolderOpen />} title="No registered projects" text="Browse to a local codebase to initialize Orchestra and start a project-scoped conversation." />}
  </section>;
}

function Tasks({ tasks, projects, onRetryPush, onRecover, onRetryTask, onStop, onApproveDisputed }: { tasks: Task[]; projects: Project[]; onRetryPush: (task: Task) => void; onRecover: (task: Task) => void; onRetryTask: (task: Task) => void; onStop: (task: Task) => void; onApproveDisputed?: (task: Task) => void }) {
  return <section><PageHeader eyebrow="Persisted execution history" title="Tasks" subtitle="Agent routing, verification, commit, and push results survive dashboard restarts." />
    <div className="table-card"><table><thead><tr><th>Task</th><th>Project</th><th>Status</th><th>Commit</th><th>Created</th><th /></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td><strong>{task.title}</strong>{task.error && <small className="failure-text">{task.error}</small>}</td><td>{projects.find((item) => item.id === task.projectId)?.name || 'Unknown'}</td><td><StateBadge state={task.state} /></td><td>{task.commitSha ? task.commitSha.slice(0, 8) : '—'}</td><td>{formatDate(task.createdAt)}</td><td>{!terminalStates.has(task.state) ? <button className="stop-button" onClick={() => onStop(task)}><Square size={12} fill="currentColor" /> Stop</button> : task.pushStatus === 'unpushed' ? <button className="secondary compact" onClick={() => onRetryPush(task)}><UploadCloud size={14} /> Retry push</button> : task.state === 'review_disputed' && onApproveDisputed ? <button className="primary compact" onClick={() => onApproveDisputed(task)}>Approve</button> : task.state === 'recovery_required' ? <button className="secondary compact" onClick={() => onRecover(task)}><RefreshCw size={14} /> Resume</button> : task.state === 'failed' ? <button className="secondary compact" onClick={() => onRetryTask(task)}><RefreshCw size={14} /> Retry</button> : null}</td></tr>)}</tbody></table></div>
  </section>;
}

function McpServersView({ servers, busy, onToggle, onRefresh }: { servers: McpServerRecord[]; busy: boolean; onToggle: (id: string, enabled: boolean) => void; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpand = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const totalTools = servers.filter((s) => s.enabled).reduce((acc, s) => acc + s.toolCount, 0);
  const activeCount = servers.filter((s) => s.enabled && s.operational).length;

  return (
    <section className="mcp-servers-page">
      <PageHeader
        eyebrow="Universal Model Context Protocol Registry"
        title="MCP Servers"
        subtitle="Inspect, probe, and toggle MCP servers across Antigravity, Codex, and Gemma."
        action={
          <button className="primary" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={15} className={busy ? 'spin' : ''} /> Refresh status
          </button>
        }
      />

      <div className="summary-strip">
        <div>
          <strong>{servers.length}</strong>
          <span>Discovered servers</span>
        </div>
        <div>
          <strong>{activeCount}</strong>
          <span>Active & operational</span>
        </div>
        <div>
          <strong>{totalTools}</strong>
          <span>Live tools available</span>
        </div>
      </div>

      <div className="mcp-grid">
        {servers.map((server) => {
          const isExpanded = Boolean(expanded[server.id]);
          const isOk = server.enabled && server.operational;
          return (
            <article key={server.id} className={`mcp-card ${server.enabled ? (server.operational ? 'active' : 'warning-card') : 'disabled-card'}`}>
              <header className="mcp-card-header">
                <div className="mcp-card-title">
                  <StatusDot ok={isOk} />
                  <strong>{server.name}</strong>
                  <span className={`mcp-badge ${server.transportType}`}>
                    {server.transportType === 'http' ? 'HTTP Stream' : 'STDIO Command'}
                  </span>
                </div>
                <button
                  type="button"
                  className={`mcp-toggle-switch ${server.enabled ? 'on' : 'off'}`}
                  onClick={() => onToggle(server.id, !server.enabled)}
                  disabled={busy}
                  title={server.enabled ? 'Click to disable across all models' : 'Click to enable across all models'}
                >
                  <span className="switch-knob" />
                  <span className="switch-label">{server.enabled ? 'ENABLED' : 'DISABLED'}</span>
                </button>
              </header>

              <div className="mcp-card-body">
                <div className="mcp-endpoint-box">
                  <Terminal size={12} />
                  <code>{server.endpoint || server.command || 'stdio process'}</code>
                </div>

                <div className="mcp-metrics-row">
                  <div>
                    <span>Tools</span>
                    <strong>{server.toolCount}</strong>
                  </div>
                  <div>
                    <span>Latency</span>
                    <strong>{server.latencyMs !== null ? `${server.latencyMs}ms` : '—'}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong className={isOk ? 'text-green' : server.enabled ? 'text-amber' : 'text-muted'}>
                      {server.enabled ? (server.operational ? 'Operational' : 'Unreachable') : 'Disabled'}
                    </strong>
                  </div>
                </div>

                <div className="mcp-models-row">
                  <span className="mcp-models-label">Model Visibility:</span>
                  <div className="mcp-models-badges">
                    <span className={`model-pill ${server.models.antigravity && server.enabled ? 'active' : 'inactive'}`}>
                      <Bot size={10} /> Antigravity
                    </span>
                    <span className={`model-pill ${server.models.codex && server.enabled ? 'active' : 'inactive'}`}>
                      <ShieldCheck size={10} /> Codex
                    </span>
                    <span className={`model-pill ${server.models.gemma && server.enabled ? 'active' : 'inactive'}`}>
                      <Zap size={10} /> Gemma
                    </span>
                  </div>
                </div>

                {server.reason && (
                  <div className="mcp-reason-box">
                    <CircleAlert size={12} />
                    <span>{server.reason}</span>
                  </div>
                )}

                {server.tools.length > 0 && (
                  <div className="mcp-tools-section">
                    <button type="button" className="tools-toggle-btn" onClick={() => toggleExpand(server.id)}>
                      <span>Registered Tools ({server.tools.length})</span>
                      <small>{isExpanded ? 'Hide' : 'Show list'}</small>
                    </button>
                    {isExpanded && (
                      <div className="mcp-tools-list">
                        {server.tools.map((tool) => (
                          <code key={tool} className="tool-chip">{tool}</code>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {!servers.length && (
        <Empty
          icon={<Server />}
          title="No MCP servers found"
          text="Configure MCP servers in ~/.gemini/config/mcp_config.json or ~/.codex/config.toml."
        />
      )}
    </section>
  );
}

function SettingsView({ settings, health, onSave }: { settings: SettingsData; health: Health; onSave: (value: Partial<SettingsData>) => void }) {
  const [interval, setIntervalValue] = useState(settings.telemetryInterval);
  const [localModel, setLocalModel] = useState(settings.lmStudioModel);
  const [policy, setPolicy] = useState<QuotaPolicy>(settings.quotaPolicy || {
    tierAbove20: { antigravityModel: 'gemini-3.7-flash-high', antigravityEffort: 'high', codexModel: 'gpt-5.6-sol', codexEffort: 'high' },
    tier15to20: { antigravityModel: 'gemini-3.7-flash-high', antigravityEffort: 'high', codexModel: 'gpt-5.6-terra', codexEffort: 'high' },
    tier10to15: { antigravityModel: 'gemini-3.7-flash-medium', antigravityEffort: 'medium', codexModel: 'gpt-5.6-terra', codexEffort: 'medium' },
    tier5to10: { antigravityModel: 'gemini-3.7-flash-low', antigravityEffort: 'low', codexModel: 'gpt-5.6-luna', codexEffort: 'low' },
    tierBelow5: { antigravityModel: 'gemini-3.7-flash-low', antigravityEffort: 'low', codexModel: null, codexEffort: null },
  });

  const detectedLmModels = health.lmStudio?.models || [];

  const updateTier = (tierKey: keyof QuotaPolicy, field: keyof QuotaTierConfig, value: string | null) => {
    setPolicy((prev) => {
      const updatedTier = { ...prev[tierKey], [field]: value === 'none' ? null : value };
      if (field === 'antigravityModel' && typeof value === 'string') {
        if (/-high\b/i.test(value)) updatedTier.antigravityEffort = 'high';
        else if (/-low\b/i.test(value)) updatedTier.antigravityEffort = 'low';
        else updatedTier.antigravityEffort = 'medium';
      }
      return { ...prev, [tierKey]: updatedTier };
    });
  };

  const tiers: Array<{ key: keyof QuotaPolicy; label: string; badge: string; desc: string }> = [
    { key: 'tierAbove20', label: '> 20% Quota Remaining', badge: 'Normal', desc: 'Full high-capacity frontier tier' },
    { key: 'tier15to20', label: '15% – 20% Quota Remaining', badge: 'Moderate', desc: 'Balanced high capability tier' },
    { key: 'tier10to15', label: '10% – 15% Quota Remaining', badge: 'Conservation', desc: 'Quota preservation with Terra medium' },
    { key: 'tier5to10', label: '5% – 10% Quota Remaining', badge: 'Critical', desc: 'Lightweight models to prevent quota exhaustion' },
    { key: 'tierBelow5', label: '< 5% Quota Remaining', badge: 'Emergency', desc: 'Emergency tier: local triage / bypass Codex' },
  ];

  return (
    <section>
      <PageHeader eyebrow="Local configuration & Quota Management" title="Settings" subtitle="Customize real-time telemetry, model routing, and quota tier policies." />
      <div className="settings-grid">
        <Card title="Local model (LM Studio)" icon={<Bot />}>
          <Field label="LM Studio URL" value={settings.lmStudioBaseUrl} />
          <Field
            label="Status"
            value={
              health.lmStudio?.modelAvailable
                ? `Connected (${detectedLmModels.length} model${detectedLmModels.length === 1 ? '' : 's'} detected)`
                : 'Unavailable or no model loaded'
            }
          />
          <div className="form-field" style={{ margin: '8px 0 0 0' }}>
            <span>Active Model (Auto-detect / Select)</span>
            {detectedLmModels.length > 0 ? (
              <select
                value={localModel}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocalModel(val);
                  onSave({ lmStudioModel: val });
                }}
              >
                {detectedLmModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={localModel}
                placeholder="gemma-4-12b-it-qat"
                onChange={(e) => setLocalModel(e.target.value)}
                onBlur={() => onSave({ lmStudioModel: localModel })}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  background: 'rgba(0,0,0,.5)',
                  color: 'var(--text)',
                  padding: '7px 9px',
                  fontSize: '11px',
                }}
              />
            )}
          </div>
          {detectedLmModels.length > 0 && (
            <small style={{ color: 'var(--cyan)', fontSize: '10px', marginTop: '6px', display: 'block' }}>
              ✓ Auto-detected from LM Studio: {localModel || detectedLmModels[0]}
            </small>
          )}
        </Card>
        <Card title="Telemetry" icon={<Activity />}>
          <label className="form-field">
            <span>Refresh interval</span>
            <select value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))}>
              <option value={1000}>1 second</option>
              <option value={2000}>2 seconds</option>
              <option value={5000}>5 seconds</option>
              <option value={10000}>10 seconds</option>
            </select>
          </label>
          <button className="primary" onClick={() => onSave({ telemetryInterval: interval, quotaPolicy: policy, lmStudioModel: localModel })}>Save settings</button>
        </Card>
      </div>

      <div style={{ marginTop: '20px' }}>
        <Card title="Quota-Based Model Routing Policy" icon={<Zap />}>
          <p style={{ color: 'var(--muted)', fontSize: '12px', marginBottom: '14px' }}>
            Orchestra dynamically shifts model reasoning and review profiles as your weekly API quota depletes. Customize the exact models and reasoning effort levels you want running at each remaining quota threshold.
          </p>
          <div className="quota-tiers-table">
            {tiers.map((t) => {
              const cfg = policy[t.key];
              return (
                <div key={t.key} className="quota-tier-row">
                  <div className="tier-meta">
                    <span className="tier-name">{t.label}</span>
                    <span className={`tier-badge tier-${t.badge.toLowerCase()}`}>{t.badge}</span>
                    <small>{t.desc}</small>
                  </div>
                  <div className="tier-controls">
                    <div className="tier-field">
                      <label>Antigravity Model</label>
                      <select value={cfg.antigravityModel} onChange={(e) => updateTier(t.key, 'antigravityModel', e.target.value)}>
                        <option value="gemini-3.7-flash-high">Gemini 3.7 Flash (High)</option>
                        <option value="gemini-3.7-flash-medium">Gemini 3.7 Flash (Medium)</option>
                        <option value="gemini-3.7-flash-low">Gemini 3.7 Flash (Low)</option>
                        <option value="gemini-3.1-pro-high">Gemini 3.1 Pro (High)</option>
                        <option value="gemini-3.1-pro-low">Gemini 3.1 Pro (Low)</option>
                        <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Thinking)</option>
                        <option value="claude-opus-4-6-thinking">Claude Opus 4.6 (Thinking)</option>
                      </select>
                    </div>
                    <div className="tier-field">
                      <label>Codex Review Model</label>
                      <select value={cfg.codexModel || 'none'} onChange={(e) => updateTier(t.key, 'codexModel', e.target.value)}>
                        <option value="gpt-5.6-sol">gpt-5.6-sol</option>
                        <option value="gpt-5.6-terra">gpt-5.6-terra</option>
                        <option value="gpt-5.6-luna">gpt-5.6-luna</option>
                        <option value="gpt-5.1">gpt-5.1</option>
                        <option value="none">None (Bypass Codex / Gemma Triage)</option>
                      </select>
                    </div>
                    <div className="tier-field">
                      <label>Codex Effort</label>
                      <select value={cfg.codexEffort || 'low'} disabled={!cfg.codexModel} onChange={(e) => updateTier(t.key, 'codexEffort', e.target.value)}>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="primary" onClick={() => onSave({ quotaPolicy: policy })}>Save Quota Policy</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: '20px' }}>
        <Card title="CLI Diagnostics" icon={<Terminal />}>
          <div className="service-list">
            {['antigravity', 'codex', 'git', 'nvidia'].map((name) => (
              <div key={name}>
                <StatusDot ok={health[name]?.available !== false} />
                <span>{name}</span>
                <small>{health[name]?.version || (health[name]?.available === false ? 'Unavailable' : 'Ready')}</small>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </section>
  );
}

function TaskActivity({ task, events, models }: { task: Task; events: TaskEvent[]; models: Record<string, string> | null }) {
  const recent = events.filter((event) => ['agent.started', 'agent.output', 'agent.completed', 'task.provider-recovery', 'task.model-takeover', 'task.review-disputed', 'task.steer', 'mcp.capability', 'mcp.tool', 'verification.result', 'git.commit', 'git.push', 'warning'].includes(event.type)).slice(-8);
  const rawPrimary = models?.primary === 'gemma' ? models.gemma : models?.antigravity;
  const primaryModel = rawPrimary ? (rawPrimary.includes('/') ? rawPrimary.split('/').pop() : rawPrimary) : '';
  return <div className="activity-card"><div className="activity-head"><RefreshCw className="spin" size={15} /><strong>{humanState(task.state)}</strong></div>{models && <small title={rawPrimary}>{primaryModel}{models.codex ? ` · ${models.codex}` : ''}</small>}<div className="activity-events">{recent.map((event) => <div key={event.id}><span className={`agent-dot ${event.agent}`} /> <strong>{event.agent}</strong><p>{eventText(event)}</p></div>)}</div></div>;
}

function Metric({ icon, label, value, detail, percent, color }: { icon: React.ReactNode; label: string; value: string; detail: string; percent: number; color: string }) { return <article className="metric-card"><div className={`metric-icon ${color}`}>{icon}</div><div className="metric-label">{label}</div><strong>{value}</strong><div className="meter"><span className={color} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div><small>{detail}</small></article>; }
function PageHeader({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: React.ReactNode }) { return <header className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>{action}</header>; }
function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <article className="card"><header>{icon}<strong>{title}</strong></header>{children}</article>; }
function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactElement; label: string; onClick: () => void }) { return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button>; }
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty">{icon}<strong>{title}</strong><p>{text}</p></div>; }
function StatusDot({ ok }: { ok: boolean }) { return <span className={`status-dot ${ok ? 'ok' : 'bad'}`} />; }
function StateBadge({ state }: { state: string }) { return <span className={`state-badge state-${state}`}>{humanState(state)}</span>; }
function Field({ label, value }: { label: string; value: string }) { return <div className="field"><span>{label}</span><strong>{value}</strong></div>; }
function humanState(state: string) { return state.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDate(value: string) { return new Date(value).toLocaleString(); }
function formatDuration(value: number) { const seconds = Math.max(0, Math.round(value / 1000)); if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m ${seconds % 60}s`; return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
function eventText(event: TaskEvent) { const payload = event.payload; if (typeof payload.message === 'string') return payload.message; if (typeof payload.text === 'string') return payload.text.slice(-900); if (typeof payload.summary === 'string') return payload.summary.slice(-900); if (event.type === 'task.state') return `Entered ${humanState(String(payload.state || 'unknown'))}.`; if (event.type === 'task.review-disputed') return `Review consensus dispute: ${String(payload.reason || 'repair attempt limit reached without consensus')}.`; if (event.type === 'task.steer') return `User provided steering guidance: ${String(payload.guidance || '').slice(0, 80)}...`; if (event.type === 'task.repair-progress') return `Automatic repair ${String(payload.attempt || '?')} of ${String(payload.maxAttempts || '?')} completed; project diff ${payload.changed ? 'changed' : 'did not change'}.`; if (event.type === 'provider.telemetry') { const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {}; const total = Number(usage.total_tokens || usage.totalTokens || 0); const input = Number(usage.input_tokens || usage.inputTokens || 0); const output = Number(usage.output_tokens || usage.outputTokens || 0); const context = payload.context && typeof payload.context === 'object' ? payload.context as Record<string, unknown> : {}; const pressure = Number(context.usedPercent); return total ? `Turn usage: ${total.toLocaleString()} cumulative tokens (${input.toLocaleString()} input, ${output.toLocaleString()} output)${Number.isFinite(pressure) ? ` · latest context ${pressure.toFixed(1)}%` : ''}.` : payload.reroute ? 'Provider rerouted the selected model.' : 'Provider telemetry updated.'; } if (event.type === 'agent.started') return `Started ${String(payload.phase || payload.role || '')}${payload.cycle ? ` cycle ${String(payload.cycle)}` : ''}`.trim(); if (event.type === 'agent.completed') return `Completed ${String(payload.phase || payload.role || '')}`.trim(); if (event.type === 'git.remote') return `Connected origin to ${String(payload.remote || 'the requested remote')}.`; if (event.type === 'git.commit') return `Created commit ${String(payload.sha || '').slice(0, 8)}`; if (event.type === 'git.push') return payload.pushed ? 'Pushed to upstream' : String(payload.error || 'Push pending'); if (event.type === 'verification.result') { const results = Array.isArray(payload.results) ? payload.results as Array<Record<string, unknown>> : []; return results.length ? `Verification completed: ${results.map((item) => `${String(item.command || 'check')} ${Number(item.code) === 0 ? 'passed' : 'failed'}`).join('; ')}.` : 'Verification completed.'; } return event.type; }
function formatProviderContext(item?: ProviderUsage) { const percent = item?.context?.usedPercent; if (percent !== null && percent !== undefined) return `${percent.toFixed(1)}%`; const tokens = item?.context?.inputTokens ?? item?.context?.totalTokens; return tokens ? `${tokens.toLocaleString()} tokens` : 'Not measured'; }

export default App;
