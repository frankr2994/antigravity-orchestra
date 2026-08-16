import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import si from 'systeminformation';
import { runProcess, commandAvailable } from './process.js';
import { lmStudioHealth } from './agents.js';
import { readAntigravityUsage, readCodexUsage } from './observability.js';

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

export async function getCodexModels(): Promise<Array<{ id: string; name: string }>> {
  const models: Array<{ id: string; name: string }> = [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (Flagship Deep Reasoning)' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra (Balanced Quality & Implementation)' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna (Fast / Budget Saver)' },
    { id: 'gpt-5.6', name: 'GPT-5.6 (Auto-Routed)' },
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
  ];

  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const configPath = join(home, '.codex', 'config.toml');
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf8');
      const match = content.match(/^model\s*=\s*["']([^"']+)["']/m);
      if (match && match[1]) {
        const configuredModel = match[1].trim();
        if (!models.some((m) => m.id === configuredModel)) {
          models.unshift({ id: configuredModel, name: `${configuredModel} (Configured Default)` });
        }
      }
    }
  } catch { /* ignore */ }

  return models;
}

export async function getUsage() {
  return {
    antigravity: await readAntigravityUsage(),
    codex: await readCodexUsage(),
  };
}

async function version(command: string) {
  try {
    const result = await runProcess(command, ['--version'], { timeoutMs: 5000 });
    return { available: result.code === 0, version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null };
  } catch (error) { return { available: false, version: null, error: error instanceof Error ? error.message : String(error) }; }
}

function finiteNumber(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) ? Math.round(number) : null; }
function roundGiB(bytes: number) { return Number((bytes / 1024 ** 3).toFixed(1)); }
