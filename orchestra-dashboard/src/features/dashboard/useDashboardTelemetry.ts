import { useCallback, useEffect, useState } from 'react';
import type { ReturnTypeApi } from '../../app/api-types';
import type {
  AvailableModels, Health, InstalledLmStudioModel, JulesActivitySummary, JulesReadiness,
  McpServerRecord, McpStatus, ProviderUsage, SettingsData, Stats,
} from '../../app/types';

export function useDashboardTelemetry(input: {
  api: ReturnTypeApi;
  token: string;
  projectId?: string;
  monitoredTaskId?: string;
  onError(message: string): void;
}) {
  const { api, token, projectId, monitoredTaskId, onError } = input;
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health>({});
  const [usage, setUsage] = useState<Record<string, ProviderUsage>>({});
  const [julesReadiness, setJulesReadiness] = useState<JulesReadiness | null>(null);
  const [julesActivity, setJulesActivity] = useState<JulesActivitySummary | null>(null);
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [settings, setSettings] = useState<SettingsData | null>(null);
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
  const [installedLmStudioModels, setInstalledLmStudioModels] = useState<InstalledLmStudioModel[]>([]);

  const fetchMcpServers = useCallback(async (force = false) => {
    try { setMcpServers(await api<McpServerRecord[]>(`/api/mcp/servers${force ? '?force=true' : ''}`)); } catch { /* Optional telemetry. */ }
  }, [api]);

  const fetchAvailableModels = useCallback(async () => {
    try {
      const data = await api<AvailableModels>('/api/models');
      if (!data) return;
      setAvailableModels((previous) => ({
        antigravity: data.antigravity?.length ? data.antigravity : previous.antigravity,
        codex: data.codex?.length ? data.codex : previous.codex,
        lmStudio: data.lmStudio || previous.lmStudio,
      }));
      if (data.lmStudio?.length) setInstalledLmStudioModels(data.lmStudio);
    } catch { /* Keep stable fallback model choices. */ }
  }, [api]);

  const refreshJulesDashboard = useCallback(async (force = false) => {
    const query = new URLSearchParams();
    if (force) query.set('force', 'true');
    if (monitoredTaskId) query.set('taskId', monitoredTaskId);
    const suffix = query.size ? `?${query.toString()}` : '';
    setUsage(await api<Record<string, ProviderUsage>>(`/api/usage${suffix}`));
    if (!projectId) { setJulesReadiness(null); setJulesActivity(null); return; }
    const [readiness, activity] = await Promise.all([
      api<JulesReadiness>(`/api/projects/${projectId}/jules-readiness${suffix}`),
      api<JulesActivitySummary>(`/api/projects/${projectId}/jules-activity-summary`),
    ]);
    setJulesReadiness(readiness); setJulesActivity(activity);
  }, [api, monitoredTaskId, projectId]);

  const toggleServer = useCallback(async (id: string, enabled: boolean) => {
    setMcpBusy(true);
    try {
      await api(`/api/mcp/servers/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
      await Promise.all([fetchMcpServers(true), api<McpStatus>('/api/telemetry/mcp').then(setMcp)]);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setMcpBusy(false); }
  }, [api, fetchMcpServers, onError]);

  useEffect(() => {
    if (!token || !settings) return;
    const update = () => Promise.all([
      api<Stats>('/api/stats'), api<Health>('/api/health'), api<McpStatus>('/api/mcp/status'),
      fetchMcpServers(), fetchAvailableModels(), refreshJulesDashboard(),
    ]).then(([nextStats, nextHealth, nextMcp]) => { setStats(nextStats); setHealth(nextHealth); setMcp(nextMcp); })
      .catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)));
    void update();
    const timer = setInterval(update, settings.telemetryInterval);
    return () => clearInterval(timer);
  }, [api, fetchAvailableModels, fetchMcpServers, onError, refreshJulesDashboard, settings, token]);

  return {
    stats, health, setHealth, usage, julesReadiness, julesActivity, mcp, mcpServers, mcpBusy,
    settings, setSettings, availableModels, installedLmStudioModels,
    fetchMcpServers, fetchAvailableModels, refreshJulesDashboard, toggleServer,
  };
}
