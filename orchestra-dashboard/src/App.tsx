import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot, Check, CircleAlert, FolderGit2, FolderOpen, Gauge, GitBranch, History, Hexagon,
  MessageSquare, Pause, Pencil, Play, Plus, Send, Server, Settings, ShieldCheck, Sparkles,
  Square, Trash2, Wrench, X, Zap,
} from 'lucide-react';
import type {
  AvailableModels, Health, InstalledLmStudioModel, JulesActivitySummary, JulesReadiness, McpServerRecord, McpStatus,
  Message, Project, ProviderUsage, RunMonitor, Session,
  SettingsData, Stats, Task, TaskEvent, View,
} from './app/types';
import { Empty, NavButton } from './shared/ui';
import { humanState } from './shared/format';
import { useApiClient } from './app/useApiClient';
import { useWorkspaceState } from './app/workspace-state';
import { CheckpointsView, Dashboard, McpServersView, Projects, SettingsView, TaskActivity } from './app/AppViews';
import { terminalStates } from './app/task-state';
import { formatGenericModelName } from './shared/model-format';

const eventNames = ['task.state', 'task.error', 'task.recovery', 'task.recovery-required', 'task.paused', 'task.resumed', 'task.repair-progress', 'task.provider-recovery', 'task.model-takeover', 'task.takeover_local', 'agent.started', 'agent.output', 'agent.completed', 'provider.telemetry', 'routing.adjustment', 'mcp.capability', 'mcp.tool', 'verification.result', 'git.baseline-required', 'git.remote', 'git.commit', 'git.push', 'cloud.activity', 'cloud.completed', 'cloud.reviewing', 'cloud.reviewed', 'cloud.repair_requested', 'cloud.cancelled', 'cloud.integrated', 'project.onboarding', 'warning'];
const manualCommitStates = new Set(['baseline_required', 'paused', 'recovery_required', 'review_disputed', 'failed']);
const releasedOwnershipStates = new Set(['completed', 'completed_unpushed', 'failed', 'cancelled']);

function App() {
  const { token, setToken, api } = useApiClient();
  const [view, setView] = useState<View>('dashboard');
  const [{ projects, project, sessions, session, messages, tasks, activeTask, projectOwnerTask, activity }, workspace] = useWorkspaceState();
  const { setProjects, setProject, setSessions, setSession, setMessages, setTasks, setActiveTask, setProjectOwnerTask, setActivity } = workspace;
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health>({});
  const [usage, setUsage] = useState<Record<string, ProviderUsage>>({});
  const [julesReadiness, setJulesReadiness] = useState<JulesReadiness | null>(null);
  const [julesActivity, setJulesActivity] = useState<JulesActivitySummary | null>(null);
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [input, setInput] = useState('');
  const [executionMode, setExecutionMode] = useState<'orchestra' | 'direct'>('orchestra');
  const [executionTarget, setExecutionTarget] = useState<'local' | 'cloud' | 'auto'>('local');
  const [directAgent, setDirectAgent] = useState<'gemma' | 'antigravity' | 'codex'>('gemma');
  const [availableModels, setAvailableModels] = useState<AvailableModels>({
    antigravity: [
      { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
      { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
      { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)' },
      { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    ],
    codex: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (Flagship Deep Reasoning)' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra (Balanced Quality & Implementation)' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna (Fast / Budget Saver)' },
    ],
    lmStudio: [],
  });
  const [soloAntigravityModel, setSoloAntigravityModel] = useState<string>('gemini-3.7-flash-high');
  const [soloCodexModel, setSoloCodexModel] = useState<string>('gpt-5.6-sol');
  const [soloCodexEffort, setSoloCodexEffort] = useState<string>('high');
  const [soloGemmaModel, setSoloGemmaModel] = useState<string>('');
  const [installedLmStudioModels, setInstalledLmStudioModels] = useState<InstalledLmStudioModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scopeWarning, setScopeWarning] = useState('');
  const [monitor, setMonitor] = useState<RunMonitor | null>(null);
  const [monitorExplanation, setMonitorExplanation] = useState('');
  const [monitorQuestion, setMonitorQuestion] = useState('');
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [editingSessionTitle, setEditingSessionTitle] = useState(false);
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const streamRef = useRef<EventSource | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const recoveryRequestsRef = useRef(new Set<string>());
  const monitoredTaskId = activeTask?.id;

  const reload = useCallback(async (projectId?: string) => {
    const [projectList, taskList] = await Promise.all([
      api<Project[]>('/api/projects'),
      api<Task[]>(`/api/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    ]);
    setProjects(projectList); setTasks(taskList);
    if (projectId) setProject(projectList.find((item) => item.id === projectId) || null);
  }, [api, setProject, setProjects, setTasks]);

  const fetchMcpServers = useCallback(async (force = false) => {
    try {
      const data = await api<McpServerRecord[]>(`/api/mcp/servers${force ? '?force=true' : ''}`);
      setMcpServers(data);
    } catch { /* ignore */ }
  }, [api]);

  const fetchAvailableModels = useCallback(async () => {
    try {
      const data = await api<AvailableModels>('/api/models');
      if (data) {
        setAvailableModels((prev) => ({
          antigravity: data.antigravity && data.antigravity.length > 0 ? data.antigravity : prev.antigravity,
          codex: data.codex && data.codex.length > 0 ? data.codex : prev.codex,
          lmStudio: data.lmStudio || prev.lmStudio,
        }));
        if (data.lmStudio && data.lmStudio.length > 0) setInstalledLmStudioModels(data.lmStudio);
      }
    } catch { /* ignore */ }
  }, [api]);

  const refreshJulesDashboard = useCallback(async (force = false) => {
    const query = new URLSearchParams();
    if (force) query.set('force', 'true');
    if (monitoredTaskId) query.set('taskId', monitoredTaskId);
    const suffix = query.size ? `?${query.toString()}` : '';
    const nextUsage = await api<Record<string, ProviderUsage>>(`/api/usage${suffix}`);
    setUsage(nextUsage);
    if (!project?.id) { setJulesReadiness(null); setJulesActivity(null); return; }
    const [nextReadiness, nextActivity] = await Promise.all([
      api<JulesReadiness>(`/api/projects/${project.id}/jules-readiness${suffix}`),
      api<JulesActivitySummary>(`/api/projects/${project.id}/jules-activity-summary`),
    ]);
    setJulesReadiness(nextReadiness); setJulesActivity(nextActivity);
  }, [api, monitoredTaskId, project?.id]);

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
      setToken(data.token); setProjects(data.projects); setTasks(data.tasks); setHealth(data.health); setSettings(data.settings);
      if (data.projects[0]) await activateProject(data.projects[0], data.token);
      void fetchMcpServers();
      void fetchAvailableModels();
    }).catch((reason) => setError(reason.message));
    return () => streamRef.current?.close();
    // Initial bootstrap must run only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchMcpServers, fetchAvailableModels]);

  useEffect(() => {
    if (!token || !settings) return;
    const update = () => Promise.all([api<Stats>('/api/stats'), api<Health>('/api/health'), api<McpStatus>('/api/mcp/status'), fetchMcpServers(), fetchAvailableModels(), refreshJulesDashboard()])
      .then(([nextStats, nextHealth, nextMcp]) => { setStats(nextStats); setHealth(nextHealth); setMcp(nextMcp); })
      .catch((reason) => setError(reason.message));
    void update();
    const timer = setInterval(update, settings.telemetryInterval);
    return () => clearInterval(timer);
  }, [api, fetchMcpServers, fetchAvailableModels, refreshJulesDashboard, settings, token]);

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
      const projectActiveTask = await api<Task | null>(`/api/projects/${nextProject.id}/task-ownership/reconcile`, { method: 'POST', body: '{}' }, overrideToken);
      const projectTasks = await api<Task[]>(`/api/tasks?projectId=${nextProject.id}`, {}, overrideToken);
      setTasks(projectTasks);
      setProjectOwnerTask(projectActiveTask);
      const visibleSession = projectActiveTask ? data.sessions.find((item) => item.id === projectActiveTask.sessionId) || data.activeSession : data.activeSession;
      setSession(visibleSession);
      setMessages(await api<Message[]>(`/api/sessions/${visibleSession.id}/messages`, {}, overrideToken));
      setActivity([]);
      const sessionTasks = projectTasks.filter((task) => task.sessionId === visibleSession.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const newestTask = sessionTasks[0] || null;
      const restored = projectActiveTask || (newestTask && (!terminalStates.has(newestTask.state) || manualCommitStates.has(newestTask.state)) ? newestTask : null);
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
      workspace.newConversation(created); await restoreProjectTask(project.id, created.id, true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function selectSession(next: Session) {
    setEditingSessionTitle(false);
    await api(`/api/sessions/${next.id}/activate`, { method: 'POST', body: '{}' });
    workspace.openSession(next, await api<Message[]>(`/api/sessions/${next.id}/messages`)); await restoreProjectTask(next.projectId, next.id);
  }

  async function renameSession(sessionId: string, newTitle: string) {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      setError('');
      const updated = await api<Session>(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      });
      setSessions((current) => current.map((s) => (s.id === sessionId ? updated : s)));
      if (session?.id === sessionId) setSession(updated);
      setEditingSessionTitle(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function deleteCurrentSession(sessionId: string) {
    if (!project) return;
    if (sessions.length <= 1) {
      if (window.confirm('Clear messages and reset this conversation?')) {
        await renameSession(sessionId, 'New conversation');
        setMessages([]);
        setActivity([]);
      }
      return;
    }
    if (!window.confirm('Are you sure you want to delete this conversation?')) return;
    try {
      setError('');
      await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      if (remaining.length > 0) {
        await selectSession(remaining[0]);
      } else {
        await newSession();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function restoreProjectTask(projectId: string, selectedSessionId: string, reconcile = false) {
    const ownerPath = `/api/projects/${projectId}/${reconcile ? 'task-ownership/reconcile' : 'active-task'}`;
    const running = await api<Task | null>(ownerPath, reconcile ? { method: 'POST', body: '{}' } : {});
    const projectTasks = await api<Task[]>(`/api/tasks?projectId=${projectId}`);
    const sessionTasks = projectTasks.filter((task) => task.sessionId === selectedSessionId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const newestTask = sessionTasks[0] || null;
    const latest = running?.sessionId === selectedSessionId
      ? running
      : !running && newestTask && (!terminalStates.has(newestTask.state) || manualCommitStates.has(newestTask.state)) ? newestTask : null;
    setTasks(projectTasks);
    setProjectOwnerTask(running);
    setActiveTask(latest);
    if (latest) watchTask(latest.id);
    else { streamRef.current?.close(); setActivity([]); setMonitor(null); }
  }

  async function openProjectOwner() {
    if (!projectOwnerTask) return;
    const ownerSession = sessions.find((item) => item.id === projectOwnerTask.sessionId);
    if (!ownerSession) {
      setError('The active task conversation is no longer available. Reload the project to reconcile its state.');
      return;
    }
    await selectSession(ownerSession);
  }

  async function send() {
    if (!session || scopeWarning || !input.trim()) return;
    const prompt = input.trim(); setError('');
    try {
      if (project) {
        const owner = await api<Task | null>(`/api/projects/${project.id}/task-ownership/reconcile`, { method: 'POST', body: '{}' });
        setProjectOwnerTask(owner);
        if (owner) {
          if (owner.sessionId === session.id) {
            setActiveTask(owner);
            watchTask(owner.id);
          }
          return;
        }
      }
      const directModel =
        executionMode === 'direct'
          ? directAgent === 'antigravity'
            ? soloAntigravityModel
            : directAgent === 'codex'
            ? soloCodexModel
            : soloGemmaModel || null
          : null;

      const directEffort =
        executionMode === 'direct'
          ? directAgent === 'antigravity'
            ? soloAntigravityModel.includes('-low')
              ? 'low'
              : soloAntigravityModel.includes('-medium')
              ? 'medium'
              : 'high'
            : directAgent === 'codex'
            ? soloCodexEffort
            : null
          : null;

      let created: Task;
      if (executionMode === 'orchestra' && executionTarget !== 'local' && project) {
        const path = executionTarget === 'cloud' ? `/api/projects/${project.id}/jules/dispatch` : `/api/projects/${project.id}/jules/execute`;
        const response = await api<{ taskId?: string; id?: string }>(path, {
          method: 'POST', body: JSON.stringify({ prompt, sessionId: session.id, target: executionTarget, idempotencyKey: crypto.randomUUID() }),
        });
        const taskId = response.taskId || response.id;
        if (!taskId) throw new Error('The execution request did not return a task identity.');
        created = await api<Task>(`/api/tasks/${taskId}`);
      } else {
        created = await api<Task>(`/api/sessions/${session.id}/tasks`, {
          method: 'POST', body: JSON.stringify({ prompt, mode: executionMode, directAgent, directModel, directEffort }),
        });
      }
      setInput('');
      setMessages((current) => [...current, { id: crypto.randomUUID(), taskId: created.id, role: 'user', agent: 'system', content: prompt, createdAt: new Date().toISOString() }]);
      setTasks((current) => [created, ...current]); setActiveTask(created); setProjectOwnerTask(created); setActivity([]); watchTask(created.id);
      if (session.title === 'New conversation' || session.title.startsWith('New conversation')) {
        void api<Session[]>(`/api/projects/${session.projectId}/sessions`).then((updatedSessions) => {
          setSessions(updatedSessions);
          const current = updatedSessions.find((s) => s.id === session.id);
          if (current) setSession(current);
        }).catch(() => undefined);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (project && message.includes('[PROJECT_TASK_ACTIVE]')) {
        try {
          const owner = await api<Task | null>(`/api/projects/${project.id}/active-task`);
          setProjectOwnerTask(owner);
          if (owner?.sessionId === session.id) { setActiveTask(owner); watchTask(owner.id); }
          if (owner) return;
        } catch { /* Show the original error when the owner cannot be loaded. */ }
      }
      setError(message);
    }
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
        setProjectOwnerTask((current) => current?.id === taskId
          ? releasedOwnershipStates.has(state) ? null : { ...current, state }
          : current);
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

  async function cancelTask(task = activeTask) {
    if (!task) return;
    if (task.target === 'cloud' && !window.confirm('Stop and delete this Jules cloud session? This cannot be resumed.')) return;
    try {
      setBusy(true); setError('');
      let updated: Task;
      if (task.target === 'cloud') {
        await api(`/api/tasks/${task.id}/jules/cancel`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: '{}' });
        updated = await api<Task>(`/api/tasks/${task.id}`);
      } else {
        updated = await api<Task>(`/api/tasks/${task.id}/cancel`, { method: 'POST', body: '{}' });
      }
      setActiveTask((current) => current?.id === task.id ? updated : current);
      setProjectOwnerTask((current) => current?.id === task.id ? releasedOwnershipStates.has(updated.state) ? null : updated : current);
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function pauseTask(task = activeTask) {
    if (!task) return;
    try {
      setBusy(true); setError('');
      const updated = await api<Task>(`/api/tasks/${task.id}/pause`, { method: 'POST', body: '{}' });
      setActiveTask((current) => current?.id === task.id ? updated : current);
      setProjectOwnerTask((current) => current?.id === task.id ? updated : current);
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function resumeTask(task = activeTask) {
    if (!task) return;
    if (task.state === 'recovery_required') return recoverTask(task);
    try {
      setBusy(true); setError('');
      const updated = await api<Task>(`/api/tasks/${task.id}/resume`, { method: 'POST', body: '{}' });
      setActiveTask((current) => current?.id === task.id ? updated : current);
      setProjectOwnerTask((current) => current?.id === task.id ? updated : current);
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
      setActivity([]); watchTask(task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function recoverTask(task: Task) {
    if (recoveryRequestsRef.current.has(task.id)) return;
    recoveryRequestsRef.current.add(task.id);
    const recovering = { ...task, state: 'recovering', error: null };
    setActiveTask((current) => current?.id === task.id ? recovering : current);
    setProjectOwnerTask((current) => current?.id === task.id ? recovering : current);
    setTasks((current) => current.map((item) => item.id === task.id ? recovering : item));
    setActivity([]); watchTask(task.id); setView('dashboard');
    try {
      setError('');
      await api(`/api/tasks/${task.id}/recover`, { method: 'POST', body: '{}' });
    } catch (reason) {
      try {
        const latest = await api<Task>(`/api/tasks/${task.id}`);
        setActiveTask((current) => current?.id === task.id ? latest : current);
        setProjectOwnerTask((current) => current?.id === task.id ? releasedOwnershipStates.has(latest.state) ? null : latest : current);
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
      setActiveTask(retrying); setProjectOwnerTask(retrying); setActivity([]); watchTask(task.id); setView('dashboard');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function retryPush(task: Task) { await api(`/api/tasks/${task.id}/retry-push`, { method: 'POST', body: '{}' }); if (project) await reload(project.id); }
  async function commitUncommittedChanges(task: Task) {
    try {
      setBusy(true); setError('');
      const updated = await api<Task>(`/api/tasks/${task.id}/commit-changes`, { method: 'POST', body: '{}' });
      setActiveTask(updated);
      setProjectOwnerTask(releasedOwnershipStates.has(updated.state) ? null : updated);
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
      const refreshes = await Promise.allSettled([
        session ? api<Message[]>(`/api/sessions/${session.id}/messages`).then(setMessages) : Promise.resolve(),
        project ? reload(project.id) : Promise.resolve(),
      ]);
      if (refreshes.some((result) => result.status === 'rejected')) {
        setScopeWarning('The commit finished, but part of the dashboard did not refresh. Reload the page if another panel looks stale.');
      }
    } catch (reason) {
      try {
        const latest = await api<Task>(`/api/tasks/${task.id}`);
        setActiveTask((current) => current?.id === task.id ? latest : current);
        setProjectOwnerTask((current) => current?.id === task.id ? releasedOwnershipStates.has(latest.state) ? null : latest : current);
        setTasks((current) => current.map((item) => item.id === task.id ? latest : item));
      } catch { /* Keep the original commit error. */ }
      setError(reason instanceof Error ? reason.message : String(reason));
    }
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
  async function forgetProject(id: string) { await api(`/api/projects/${id}`, { method: 'DELETE' }); if (project?.id === id) { setProject(null); setSession(null); setMessages([]); setActiveTask(null); setProjectOwnerTask(null); } await reload(); }

  const currentModels = useMemo(() => {
    try { return activeTask?.models ? JSON.parse(activeTask.models) : null; } catch { return null; }
  }, [activeTask]);
  const uncommittedFileCount = monitor?.changedFiles.length ?? 0;
  const showManualCommit = Boolean(activeTask && activeTask.target !== 'cloud' && manualCommitStates.has(activeTask.state) && uncommittedFileCount > 0);
  const projectOwnerElsewhere = Boolean(projectOwnerTask && session && projectOwnerTask.sessionId !== session.id);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Hexagon size={28} fill="currentColor" /><div><strong>ORCHESTRA</strong><span>Command Center</span></div></div>
        <nav>
          <NavButton active={view === 'dashboard'} icon={<Gauge />} label="Dashboard" onClick={() => setView('dashboard')} />
          <NavButton active={view === 'projects'} icon={<FolderGit2 />} label="Projects" onClick={() => setView('projects')} />
          <NavButton active={view === 'checkpoints' || view === 'tasks'} icon={<History />} label="Checkpoints" onClick={() => setView('checkpoints')} />
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
        {view === 'dashboard' && <Dashboard api={api} stats={stats} health={health} usage={usage} julesReadiness={julesReadiness} julesActivity={julesActivity} mcp={mcp} project={project} tasks={tasks} activeTask={activeTask} monitor={monitor} events={activity} explanation={monitorExplanation} explanationBusy={monitorBusy} question={monitorQuestion} onQuestion={setMonitorQuestion} onAsk={askMonitor} onExplain={explainMonitor} onPause={pauseTask} onResume={resumeTask} onStop={cancelTask} onConfigureJules={() => setView('settings')} onRefreshJules={refreshJulesDashboard} />}
        {view === 'projects' && <Projects projects={projects} activeId={project?.id} busy={busy} onBrowse={browseProject} onActivate={activateProject} onForget={forgetProject} />}
        {(view === 'checkpoints' || view === 'tasks') && <CheckpointsView project={project} tasks={tasks} api={api} onLoadPrompt={(txt) => setInput(txt)} onRetryPush={retryPush} onRetryTask={retryTask} />}
        {view === 'mcp' && <McpServersView servers={mcpServers} busy={mcpBusy} onToggle={toggleServer} onRefresh={() => fetchMcpServers(true)} />}
        {view === 'settings' && settings && <SettingsView settings={settings} health={health} availableModels={availableModels} api={api} onSave={async (value) => setSettings(await api<SettingsData>('/api/settings', { method: 'PATCH', body: JSON.stringify(value) }))} />}
      </main>

      <aside className="chat-panel">
        <header className="chat-header">
          <div><span className="eyebrow">Project-scoped workspace</span><strong><MessageSquare size={17} /> Tri-Agent Chat</strong></div>
          <button className="icon-button" title="New conversation" onClick={newSession} disabled={!project}><Plus size={18} /></button>
        </header>
        {editingSessionTitle && session ? (
          <div className="session-row editing">
            <input
              type="text"
              className="session-title-input"
              value={sessionTitleDraft}
              onChange={(e) => setSessionTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void renameSession(session.id, sessionTitleDraft);
                if (e.key === 'Escape') setEditingSessionTitle(false);
              }}
              placeholder="Conversation title..."
              autoFocus
            />
            <div className="session-actions">
              <button
                className="icon-button mini success"
                title="Save title (Enter)"
                onClick={() => renameSession(session.id, sessionTitleDraft)}
              >
                <Check size={13} />
              </button>
              <button
                className="icon-button mini"
                title="Cancel (Esc)"
                onClick={() => setEditingSessionTitle(false)}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        ) : (
          <div className="session-row">
            <div className="session-select-wrapper">
              <select
                value={session?.id || ''}
                onChange={(event) => {
                  const next = sessions.find((item) => item.id === event.target.value);
                  if (next) void selectSession(next);
                }}
                disabled={!sessions.length}
              >
                {!sessions.length && <option>Select a project</option>}
                {sessions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </div>
            {session && (
              <div className="session-actions">
                <button
                  className="icon-button mini"
                  title="Rename conversation"
                  onClick={() => {
                    setSessionTitleDraft(session.title);
                    setEditingSessionTitle(true);
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-button mini danger"
                  title="Delete conversation"
                  onClick={() => deleteCurrentSession(session.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>
        )}
        <div className="messages" ref={messagesRef}>
          {!project && <Empty icon={<FolderOpen />} title="Choose a project" text="Every conversation and agent process is pinned to a selected directory." />}
          {project && messages.length === 0 && !projectOwnerElsewhere && <Empty icon={<Bot />} title={`Ready in ${project.name}`} text="Describe what you want done. Model selection and agent delegation are automatic." />}
          {projectOwnerElsewhere && projectOwnerTask && <div className="baseline-card"><CircleAlert /><strong>Another conversation is using this project</strong><p>“{projectOwnerTask.title}” is {humanState(projectOwnerTask.state)}. Open that conversation to resume, commit, or stop it.</p><button className="primary" onClick={() => void openProjectOwner()}>Open active task</button></div>}
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
          {showManualCommit && activeTask && <div className="baseline-card"><CircleAlert /><strong>Uncommitted changes</strong><p>{uncommittedFileCount} project file{uncommittedFileCount === 1 ? ' has' : 's have'} uncommitted changes.</p><button className="primary" onClick={() => commitUncommittedChanges(activeTask)} disabled={busy || monitor?.processAlive === true}>{busy ? 'Committing…' : 'Commit & Push Changes'}</button></div>}
        </div>
        <div className="composer">
          {activeTask && !terminalStates.has(activeTask.state) && activeTask.state !== 'baseline_required' && <div className="monitor-actions">
            {activeTask.state === 'paused'
              ? <button className="secondary compact" onClick={() => void resumeTask()} disabled={busy}><Play size={12} fill="currentColor" /> Resume task</button>
              : activeTask.target !== 'cloud' && ['queued', 'preflight', 'routing', 'running', 'recovering', 'reviewing', 'verifying'].includes(activeTask.state)
                ? <button className="secondary compact" onClick={() => void pauseTask()} disabled={busy}><Pause size={12} /> Pause task</button>
                : null}
            {!(activeTask.target === 'cloud' && monitor?.providerState === 'COMPLETED') && <button className="stop-button" onClick={() => void cancelTask()} disabled={busy}><Square size={12} fill="currentColor" /> {activeTask.target === 'cloud' ? 'Stop Jules' : 'Stop task'}</button>}
          </div>}
          {activeTask?.state === 'recovery_required' && <div className="monitor-actions"><button className="secondary compact" onClick={() => void resumeTask()} disabled={busy}><Play size={12} fill="currentColor" /> Resume task</button><button className="stop-button" onClick={() => void cancelTask()} disabled={busy}><Square size={12} fill="currentColor" /> Stop task</button></div>}
          {activeTask && ['baseline_required', 'review_disputed'].includes(activeTask.state) && <div className="monitor-actions"><button className="stop-button" onClick={() => void cancelTask()} disabled={busy}><Square size={12} fill="currentColor" /> Stop task</button></div>}
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
              <Zap size={13} /> Gemma Solo
            </button>
            <button
              type="button"
              className={`mode-pill ${executionMode === 'direct' && directAgent === 'codex' ? 'active' : ''}`}
              onClick={() => { setExecutionMode('direct'); setDirectAgent('codex'); }}
              title="Direct Solo Consultation with Codex"
            >
              <ShieldCheck size={13} /> Codex Solo
            </button>
            <button
              type="button"
              className={`mode-pill ${executionMode === 'direct' && directAgent === 'antigravity' ? 'active' : ''}`}
              onClick={() => { setExecutionMode('direct'); setDirectAgent('antigravity'); }}
              title="Direct Solo Chat with Antigravity (Gemini read-only inspection)"
            >
              <Sparkles size={13} /> Antigravity Solo
            </button>
          </div>

          {executionMode === 'direct' && directAgent === 'antigravity' && (
            <div className="solo-model-picker">
              <span>Model:</span>
              <select value={soloAntigravityModel} onChange={(e) => setSoloAntigravityModel(e.target.value)}>
                {availableModels.antigravity.map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
              </select>
            </div>
          )}

          {executionMode === 'direct' && directAgent === 'codex' && (
            <div className="solo-model-picker">
              <span>Model:</span>
              <select
                value={soloCodexModel}
                onChange={(e) => {
                  const newModelId = e.target.value;
                  setSoloCodexModel(newModelId);
                  const descriptor = availableModels.codex.find((m) => m.id === newModelId);
                  if (descriptor?.supportedEfforts && !descriptor.supportedEfforts.some((eff) => eff.effort === soloCodexEffort)) {
                    setSoloCodexEffort(descriptor.defaultEffort || descriptor.supportedEfforts[0]?.effort || 'medium');
                  }
                }}
              >
                {availableModels.codex.map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
              </select>
              <span>Effort:</span>
              <select value={soloCodexEffort} onChange={(e) => setSoloCodexEffort(e.target.value)}>
                {(() => {
                  const currentDescriptor = availableModels.codex.find((m) => m.id === soloCodexModel);
                  const efforts = currentDescriptor?.supportedEfforts && currentDescriptor.supportedEfforts.length > 0
                    ? currentDescriptor.supportedEfforts
                    : [
                        { effort: 'low', description: 'Low' },
                        { effort: 'medium', description: 'Medium' },
                        { effort: 'high', description: 'High' },
                      ];
                  return efforts.map((eff) => (
                    <option key={eff.effort} value={eff.effort}>
                      {eff.effort.charAt(0).toUpperCase() + eff.effort.slice(1)}
                    </option>
                  ));
                })()}
              </select>
            </div>
          )}

          {executionMode === 'direct' && directAgent === 'gemma' && (
            <div className="solo-model-picker">
              <span>Local Model:</span>
              <select value={soloGemmaModel} onChange={(e) => setSoloGemmaModel(e.target.value)}>
                <option value="">Auto (Active LM Studio Model)</option>
                {installedLmStudioModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.state === 'loaded' ? '🟢 ' : '⚪ '}
                    {formatGenericModelName(m)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {executionMode === 'orchestra' && <div className="solo-model-picker"><span>Execution:</span><select value={executionTarget} onChange={(event) => setExecutionTarget(event.target.value as 'local' | 'cloud' | 'auto')}><option value="local">Local agents</option><option value="cloud">Jules cloud</option><option value="auto">Auto route</option></select></div>}
          <div className="composer-box">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
              placeholder={
                projectOwnerElsewhere
                  ? 'Open the active task before starting work in this project…'
                  : scopeWarning
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
            <button className="send-button" onClick={send} disabled={!session || Boolean(scopeWarning) || !input.trim() || Boolean(projectOwnerTask)}><Send size={17} /></button>
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

export default App;
