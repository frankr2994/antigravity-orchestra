import { getLoadedLmStudioModels, loadLmStudioModel, unloadLmStudioModel } from './agents.js';
import { getComfyUrl } from './comfy.js';
import { config } from './config.js';

export interface GpuMemoryInfo {
  vramTotal: number;
  vramFree: number;
  percentUsed: number;
  gpuName: string;
}

export type PipelineStage =
  | 'idle'
  | 'txt2img'
  | 'img2img'
  | 'inpaint'
  | 'controlnet'
  | 'ipadapter'
  | 'segmentation'
  | 'video_gen'
  | 'video_inpaint'
  | 'upscale'
  | 'vision_review'
  // Backward compatibility aliases:
  | 'concept'
  | 'reconstruction'
  | 'vision';

let currentStage: PipelineStage = 'idle';

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
  targetStep: PipelineStage,
  endpoint = getComfyUrl()
): Promise<void> {
  if (targetStep !== currentStage) {
    if (targetStep === 'vision_review' || targetStep === 'vision') {
      // 1. Free ComfyUI models from VRAM so LM Studio has full headroom for Gemma Vision
      await freeComfyMemory(endpoint);

      // 2. Automatically load Gemma Vision model in LM Studio if not already loaded
      try {
        const loadedModels = await getLoadedLmStudioModels();
        const hasVisionModel = loadedModels.some(
          (m) => m.toLowerCase().includes('gemma') || m.toLowerCase().includes('vision')
        );
        if (!hasVisionModel) {
          const visionModel = config.lmStudioModel || 'gemma-4-12b-it-qat';
          await loadLmStudioModel(visionModel, { gpu: 'max' });
        }
      } catch {
        // Fall through to allow request to proceed or yield informative endpoint error
      }
    } else if (targetStep !== 'idle') {
      // Generative task: unload LM Studio first to prevent VRAM over-commit thrashing
      await unloadLmStudioModel().catch(() => {});
      await freeComfyMemory(endpoint);
    }
    currentStage = targetStep;
  }
}
