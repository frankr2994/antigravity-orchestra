import si from 'systeminformation';
import { runProcess, commandAvailable } from './process.js';
import { lmStudioHealth } from './agents.js';
import { readAntigravityUsage, readCodexUsage } from './observability.js';
import type { Store } from './db.js';
import { ProviderUsageService } from './application/usage/provider-usage-service.js';

let cachedStats: { at: number; value: unknown } | null = null;

export async function getStats() {
  if (cachedStats && Date.now() - cachedStats.at < 1500) return cachedStats.value;
  const [memory, cpu, load, graphics] = await Promise.all([si.mem(), si.cpu(), si.currentLoad(), si.graphics()]);
  let gpuLoad: number | null = null;
  let gpuTemp: number | null = null;
  let gpuName = graphics.controllers[0]?.model || 'Unavailable';
  try {
    const result = await runProcess('nvidia-smi.exe', ['--query-gpu=name,utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 3000 });
    if (result.code === 0) {
      const [name, loadValue, temp] = result.stdout.trim().split(',').map((part) => part.trim());
      gpuName = name || gpuName;
      gpuLoad = finiteNumber(loadValue);
      gpuTemp = finiteNumber(temp);
    }
  } catch {
    gpuLoad = finiteNumber(graphics.controllers[0]?.utilizationGpu);
    gpuTemp = finiteNumber(graphics.controllers[0]?.temperatureGpu);
  }
  const value = {
    cpu: { load: Math.round(load.currentLoad), speed: cpu.speed ? `${cpu.speed.toFixed(2)} GHz` : null, name: `${cpu.manufacturer} ${cpu.brand}`.trim() },
    memory: { used: roundGiB(memory.active), total: roundGiB(memory.total), percent: Math.round((memory.active / memory.total) * 100) },
    gpu: { load: gpuLoad, name: gpuName, temp: gpuTemp },
    timestamp: new Date().toISOString(),
  };
  cachedStats = { at: Date.now(), value };
  return value;
}

export async function getHealth() {
  const [agy, codex, git, lmStudio, nvidia] = await Promise.all([
    version('agy.exe'), version('codex.exe'), version('git.exe'), lmStudioHealth(), commandAvailable('nvidia-smi.exe'),
  ]);
  return { backend: { available: true, version: '1.0.0' }, antigravity: agy, codex, git, lmStudio, nvidia: { available: nvidia } };
}

let cachedAgyModels: { at: number; models: Array<{ id: string; name: string }> } | null = null;

export async function getAntigravityModels(): Promise<Array<{ id: string; name: string }>> {
  if (cachedAgyModels && Date.now() - cachedAgyModels.at < 60_000) {
    return cachedAgyModels.models;
  }
  try {
    const result = await runProcess('agy.exe', ['models'], { timeoutMs: 5000 });
    if (result.stdout) {
      const lines = result.stdout.split(/\r?\n/);
      const models: Array<{ id: string; name: string }> = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Fetching')) continue;
        const [id, ...rest] = trimmed.split(/\t+/);
        if (id && rest.length > 0) {
          models.push({ id: id.trim(), name: rest.join(' ').trim() });
        } else if (id && !id.includes(' ')) {
          models.push({ id: id.trim(), name: id.trim() });
        }
      }
      if (models.length > 0) {
        cachedAgyModels = { at: Date.now(), models };
        return models;
      }
    }
  } catch { /* ignore */ }
  return [
    { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
    { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
    { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)' },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
    { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  ];
}

export interface CodexModelDescriptor {
  id: string;
  name: string;
  description?: string;
  defaultEffort?: string;
  supportedEfforts?: Array<{ effort: string; description?: string }>;
}

let cachedCodexModels: { at: number; models: CodexModelDescriptor[] } | null = null;

export async function getCodexModels(): Promise<CodexModelDescriptor[]> {
  if (cachedCodexModels && Date.now() - cachedCodexModels.at < 60_000) {
    return cachedCodexModels.models;
  }
  try {
    const result = await runProcess('codex.exe', ['debug', 'models'], { timeoutMs: 5000 });
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed.models)) {
        const models: CodexModelDescriptor[] = parsed.models
          .filter((m: any) => m && m.visibility !== 'hide' && m.slug)
          .map((m: any) => ({
            id: String(m.slug),
            name: String(m.display_name || m.slug),
            description: m.description ? String(m.description) : undefined,
            defaultEffort: m.default_reasoning_level ? String(m.default_reasoning_level) : undefined,
            supportedEfforts: Array.isArray(m.supported_reasoning_levels)
              ? m.supported_reasoning_levels.map((lvl: any) => ({
                  effort: String(lvl.effort),
                  description: lvl.description ? String(lvl.description) : undefined,
                }))
              : undefined,
          }));
        if (models.length > 0) {
          cachedCodexModels = { at: Date.now(), models };
          return models;
        }
      }
    }
  } catch { /* ignore fallback */ }

  return [
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6-Sol',
      description: 'Latest frontier agentic coding model.',
      defaultEffort: 'low',
      supportedEfforts: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
        { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
        { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
    },
    {
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6-Terra',
      description: 'Balanced agentic coding model for everyday work.',
      defaultEffort: 'medium',
      supportedEfforts: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
        { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
        { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
    },
    {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6-Luna',
      description: 'Fast and affordable agentic coding model.',
      defaultEffort: 'medium',
      supportedEfforts: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
        { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
      ],
    },
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      defaultEffort: 'medium',
      supportedEfforts: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
      ],
    },
    {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      defaultEffort: 'medium',
      supportedEfforts: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
      ],
    },
    {
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4-Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      defaultEffort: 'medium',
      supportedEfforts: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
      ],
    },
  ];
}

export async function getUsage(store: Store, jules?: () => Promise<unknown>, taskId?: string) {
  const [antigravity, codex, julesUsage] = await Promise.all([
    readAntigravityUsage(),
    readCodexUsage(),
    jules ? jules() : Promise.resolve(undefined),
  ]);
  const usage: Record<string, unknown> = {
    antigravity,
    codex,
  };
  if (julesUsage !== undefined) usage.jules = julesUsage;
  const activity = new ProviderUsageService(store).activity(taskId);
  for (const provider of ['gemma', 'jules', 'antigravity', 'codex'] as const) {
    const current = usage[provider];
    usage[provider] = current && typeof current === 'object'
      ? { ...(current as Record<string, unknown>), activity: activity[provider] }
      : { available: provider === 'gemma', source: provider === 'gemma' ? 'LM Studio provider runs' : 'provider runs', activity: activity[provider] };
  }
  return usage;
}

async function version(command: string) {
  try {
    const result = await runProcess(command, ['--version'], { timeoutMs: 5000 });
    return { available: result.code === 0, version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null };
  } catch (error) { return { available: false, version: null, error: error instanceof Error ? error.message : String(error) }; }
}

function finiteNumber(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) ? Math.round(number) : null; }
function roundGiB(bytes: number) { return Number((bytes / 1024 ** 3).toFixed(1)); }
