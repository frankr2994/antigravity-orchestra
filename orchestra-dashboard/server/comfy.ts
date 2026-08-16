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
  error?: string;
}

const DEFAULT_COMFY_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';

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
    if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
      const nodeData = (await infoRes.value.json()) as Record<string, any>;
      available3DNodes = Object.keys(nodeData).filter((k) =>
        /3d|mesh|tripo|trellis|hunyuan|glb|obj|voxel/i.test(k)
      );
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
    };
  } catch (error) {
    return {
      available: false,
      endpoint,
      devices: [],
      queueRemaining: 0,
      has3DNodes: false,
      available3DNodes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface GenerationProgress {
  promptId: string;
  step: number;
  maxSteps: number;
  node: string;
  status: 'queued' | 'generating' | 'reconstructing' | 'completed' | 'error';
  message?: string;
  outputFiles?: Array<{ filename: string; subfolder: string; type: string }>;
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

export async function getComfyHistory(
  promptId: string,
  endpoint = DEFAULT_COMFY_URL
): Promise<any> {
  const res = await fetch(`${endpoint}/history/${promptId}`);
  if (!res.ok) throw new Error(`Failed to fetch history for prompt ${promptId}: HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, any>;
  return data[promptId] || null;
}

export async function fetchComfyFile(
  filename: string,
  subfolder = '',
  type = 'output',
  endpoint = DEFAULT_COMFY_URL
): Promise<{ buffer: Buffer; contentType: string }> {
  const url = `${endpoint}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(
    subfolder
  )}&type=${encodeURIComponent(type)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to retrieve file from ComfyUI: HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}
