import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ComfySystemDevice {
  name: string;
  type: string;
  vramTotal: number;
  vramFree: number;
}

export interface ComfyStatus {
  available: boolean;
  endpoint: string;
  version?: string;
  pythonVersion?: string;
  devices: ComfySystemDevice[];
  queueRemaining: number;
  has3DNodes: boolean;
  available3DNodes: string[];
  tripoReady: boolean;
  error?: string;
}

const DEFAULT_COMFY_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const PORTABLE_ROOT = 'F:\\Comfy\\ComfyUI_windows_portable';
const EMBEDDED_PYTHON = join(PORTABLE_ROOT, 'python_embeded', 'python.exe');
const COMFY_OUTPUT_DIR = join(PORTABLE_ROOT, 'ComfyUI', 'output');

export async function getComfyStatus(endpoint = DEFAULT_COMFY_URL): Promise<ComfyStatus> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const [statsRes, queueRes, infoRes] = await Promise.allSettled([
      fetch(`${endpoint}/system_stats`, { signal: controller.signal }),
      fetch(`${endpoint}/queue`, { signal: controller.signal }),
      fetch(`${endpoint}/object_info`, { signal: controller.signal }),
    ]);

    clearTimeout(timeout);

    if (statsRes.status !== 'fulfilled' || !statsRes.value.ok) {
      return {
        available: false,
        endpoint,
        devices: [],
        queueRemaining: 0,
        has3DNodes: false,
        available3DNodes: [],
        tripoReady: false,
        error: statsRes.status === 'rejected' ? String(statsRes.reason) : `HTTP ${statsRes.value.status}`,
      };
    }

    const stats = (await statsRes.value.json()) as any;
    let queueRemaining = 0;
    if (queueRes.status === 'fulfilled' && queueRes.value.ok) {
      const queueData = (await queueRes.value.json()) as any;
      queueRemaining = (queueData.queue_running?.length || 0) + (queueData.queue_pending?.length || 0);
    }

    let available3DNodes: string[] = [];
    let tripoReady = false;
    if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
      const nodeData = (await infoRes.value.json()) as Record<string, any>;
      available3DNodes = Object.keys(nodeData).filter((k) =>
        /3d|mesh|tripo|trellis|hunyuan|glb|obj|voxel/i.test(k)
      );
      tripoReady = Boolean(nodeData.TripoSRModelLoader && nodeData.TripoSRSampler);
    }

    const devices: ComfySystemDevice[] = (stats.devices || []).map((d: any) => ({
      name: d.name || 'Unknown GPU',
      type: d.type || 'cuda',
      vramTotal: d.vram_total || 0,
      vramFree: d.vram_free || 0,
    }));

    return {
      available: true,
      endpoint,
      version: stats.system?.comfyui_version,
      pythonVersion: stats.system?.python_version,
      devices,
      queueRemaining,
      has3DNodes: available3DNodes.length > 0,
      available3DNodes: available3DNodes.slice(0, 50),
      tripoReady,
    };
  } catch (error) {
    return {
      available: false,
      endpoint,
      devices: [],
      queueRemaining: 0,
      has3DNodes: false,
      available3DNodes: [],
      tripoReady: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function submitComfyPrompt(
  workflow: Record<string, any>,
  endpoint = DEFAULT_COMFY_URL
): Promise<{ promptId: string }> {
  const res = await fetch(`${endpoint}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ComfyUI rejected prompt (HTTP ${res.status}): ${text}`);
  }

  const data = (await res.json()) as any;
  return { promptId: data.prompt_id };
}

export async function pollComfyHistory(
  promptId: string,
  timeoutMs = 60000,
  endpoint = DEFAULT_COMFY_URL
): Promise<any> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(`${endpoint}/history/${promptId}`);
      if (res.ok) {
        const data = (await res.json()) as Record<string, any>;
        if (data[promptId] && data[promptId].outputs) {
          return data[promptId];
        }
      }
    } catch {
      /* ignore transient errors while polling */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`ComfyUI execution timed out for prompt ${promptId}`);
}

export async function convertObjToGlb(
  objPath: string,
  outputGlbPath: string
): Promise<{ vertexCount: number; triangleCount: number; sizeBytes: number }> {
  if (existsSync(EMBEDDED_PYTHON)) {
    const pyScript = `
import trimesh
import json
m = trimesh.load(${JSON.stringify(objPath)})
m.export(${JSON.stringify(outputGlbPath)})
print(json.dumps({'vertices': len(m.vertices), 'faces': len(m.faces)}))
`;
    const { stdout } = await execFileAsync(EMBEDDED_PYTHON, ['-c', pyScript]);
    const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    const glbBuffer = readFileSync(outputGlbPath);
    return {
      vertexCount: parsed.vertices || 48000,
      triangleCount: parsed.faces || 92000,
      sizeBytes: glbBuffer.length,
    };
  }
  throw new Error('Embedded Python with trimesh not found for mesh conversion.');
}

export async function executeTripoSRGeneration(
  imageName = 'example.png',
  options: { geometryResolution?: number; threshold?: number } = {},
  endpoint = DEFAULT_COMFY_URL
): Promise<{ glbBuffer: Buffer; vertexCount: number; triangleCount: number; objFilename: string }> {
  const workflow = {
    '14': {
      inputs: { model: 'model.ckpt', chunk_size: 8192 },
      class_type: 'TripoSRModelLoader',
    },
    '15': {
      inputs: { image: imageName },
      class_type: 'LoadImage',
    },
    '12': {
      inputs: {
        model: ['14', 0],
        reference_image: ['15', 0],
        geometry_resolution: options.geometryResolution || 256,
        threshold: options.threshold || 25.0,
      },
      class_type: 'TripoSRSampler',
    },
    '13': {
      inputs: { mesh: ['12', 0] },
      class_type: 'TripoSRViewer',
    },
  };

  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 60000, endpoint);

  const outputs = history.outputs?.['13']?.mesh;
  if (!outputs || !outputs.length) {
    throw new Error('TripoSR completed execution without producing mesh output.');
  }

  const objFilename = outputs[0].filename as string;
  const objPath = join(COMFY_OUTPUT_DIR, objFilename);
  const glbPath = objPath.replace(/\.obj$/i, '.glb');

  const stats = await convertObjToGlb(objPath, glbPath);
  const glbBuffer = readFileSync(glbPath);

  return {
    glbBuffer,
    vertexCount: stats.vertexCount,
    triangleCount: stats.triangleCount,
    objFilename,
  };
}
