import { getComfyUrl } from './comfy.js';

export interface GpuMemoryInfo {
  vramTotal: number;
  vramFree: number;
  percentUsed: number;
  gpuName: string;
}

export async function freeComfyMemory(endpoint = getComfyUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getGpuMemory(endpoint = getComfyUrl()): Promise<GpuMemoryInfo | null> {
  try {
    const res = await fetch(`${endpoint}/system_stats`);
    if (!res.ok) return null;
    const stats = (await res.json()) as any;
    const device = stats.devices?.[0];
    if (!device) return null;

    const vramTotal = device.vram_total || 0;
    const vramFree = device.vram_free || 0;
    const used = vramTotal - vramFree;
    const percentUsed = vramTotal > 0 ? Math.round((used / vramTotal) * 100) : 0;

    return {
      vramTotal,
      vramFree,
      percentUsed,
      gpuName: device.name || 'CUDA Device',
    };
  } catch {
    return null;
  }
}

export async function stageGpuForStep(
  targetStep: 'concept' | 'reconstruction' | 'vision',
  endpoint = getComfyUrl()
): Promise<void> {
  // If moving from concept generation to 3D reconstruction, unload 2D diffusion weights
  if (targetStep === 'reconstruction' || targetStep === 'vision') {
    await freeComfyMemory(endpoint);
  }
}
