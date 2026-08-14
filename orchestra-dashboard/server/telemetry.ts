import si from 'systeminformation';
import { runProcess, commandAvailable } from './process.js';
import { lmStudioHealth } from './agents.js';

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

export function getUsage() {
  return {
    antigravity: { available: false, reason: 'The installed CLI does not expose stable machine-readable usage data.', checkedAt: new Date().toISOString() },
    codex: { available: false, reason: 'The installed CLI does not expose stable machine-readable usage data.', checkedAt: new Date().toISOString() },
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
