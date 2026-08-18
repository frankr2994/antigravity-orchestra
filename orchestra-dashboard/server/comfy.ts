import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildConceptGenerationWorkflow,
  buildTripoSRWorkflow,
  buildSdxlTxt2ImgWorkflow,
  buildSdxlImg2ImgWorkflow,
  buildSdxlInpaintWorkflow,
  buildSdxlIpAdapterWorkflow,
  buildLtxImg2VidWorkflow,
  buildWanTxt2VidWorkflow,
  buildWanImg2VidWorkflow,
  buildFluxTxt2ImgWorkflow,
  type ConceptGenParams,
  type SdxlTxt2ImgParams,
  type SdxlImg2ImgParams,
  type SdxlInpaintParams,
  type SdxlIpAdapterParams,
  type LtxImg2VidParams,
  type WanTxt2VidParams,
  type WanImg2VidParams,
  type FluxTxt2ImgParams,
} from './workflow-loader.js';
import { sanitizeAndExportGlb, type MeshQAStats } from './mesh-qa.js';

export interface ComfySystemDevice {
  name: string;
  type: string;
  vramTotal: number;
  vramFree: number;
}

export interface ComfyInstallation {
  rootPath: string;
  pythonPath: string;
  comfyCoreDir: string;
  outputDir: string;
  inputDir: string;
  modelsDir: string;
  customNodesDir: string;
  isPortable: boolean;
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
  installation: ComfyInstallation | null;
  error?: string;
}

export function getComfyUrl(): string {
  return process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
}

export function findComfyInstallation(): ComfyInstallation | null {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    process.env.COMFYUI_PATH,
    'F:\\Comfy\\ComfyUI_windows_portable',
    'C:\\ComfyUI_windows_portable',
    'D:\\ComfyUI_windows_portable',
    'E:\\ComfyUI_windows_portable',
    'C:\\ComfyUI',
    'D:\\ComfyUI',
    'E:\\ComfyUI',
    'F:\\ComfyUI',
    join(home, 'ComfyUI_windows_portable'),
    join(home, 'ComfyUI'),
  ].filter((p): p is string => Boolean(p && existsSync(p)));

  for (const root of candidates) {
    const embeddedPython = join(root, 'python_embeded', 'python.exe');
    const isPortable = existsSync(embeddedPython);
    const pythonPath = isPortable ? embeddedPython : (process.platform === 'win32' ? 'python.exe' : 'python3');

    const comfyCoreDir = existsSync(join(root, 'ComfyUI')) ? join(root, 'ComfyUI') : root;
    const outputDir = join(comfyCoreDir, 'output');
    const inputDir = join(comfyCoreDir, 'input');
    const modelsDir = join(comfyCoreDir, 'models');
    const customNodesDir = join(comfyCoreDir, 'custom_nodes');

    if (existsSync(comfyCoreDir) && (existsSync(modelsDir) || existsSync(customNodesDir))) {
      return {
        rootPath: root,
        pythonPath,
        comfyCoreDir,
        outputDir,
        inputDir,
        modelsDir,
        customNodesDir,
        isPortable,
      };
    }
  }

  return null;
}

export async function getComfyStatus(endpoint = getComfyUrl()): Promise<ComfyStatus> {
  const installation = findComfyInstallation();

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
        installation,
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
      installation,
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
      installation,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function submitComfyPrompt(
  workflow: Record<string, any>,
  endpoint = getComfyUrl()
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
  if (data.error) {
    throw new Error(`ComfyUI prompt error: ${JSON.stringify(data.error)}`);
  }
  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new Error(`ComfyUI node validation errors: ${JSON.stringify(data.node_errors)}`);
  }

  return { promptId: data.prompt_id };
}

export async function pollComfyHistory(
  promptId: string,
  timeoutMs = 300000,
  endpoint = getComfyUrl()
): Promise<any> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(`${endpoint}/history/${promptId}`);
      if (res.ok) {
        const data = (await res.json()) as Record<string, any>;
        if (data[promptId]) {
          const item = data[promptId];
          if (item.status?.status_str === 'error') {
            const msgs = item.status.messages || [];
            const errorMsg = msgs.map((m: any) => JSON.stringify(m)).join('; ');
            throw new Error(`ComfyUI execution failed: ${errorMsg}`);
          }
          if (item.outputs && Object.keys(item.outputs).length > 0) {
            return item;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('ComfyUI execution failed')) {
        throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`ComfyUI execution timed out after ${timeoutMs / 1000}s for prompt ${promptId}`);
}

export async function convertObjToGlb(
  objPath: string,
  outputGlbPath: string
): Promise<MeshQAStats> {
  return sanitizeAndExportGlb(objPath, outputGlbPath);
}

export async function executeConceptGeneration(
  params: ConceptGenParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildConceptGenerationWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['9']?.images;
  if (!images || !images.length) {
    throw new Error('Concept art generation completed without producing image output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`Concept image not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return {
    filename,
    localPath,
    buffer,
  };
}

export async function executeTripoSRGeneration(
  imageName: string,
  options: { geometryResolution?: number; threshold?: number } = {},
  endpoint = getComfyUrl()
): Promise<{ glbBuffer: Buffer; stats: MeshQAStats; objFilename: string }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildTripoSRWorkflow({
    imageName,
    geometryResolution: options.geometryResolution,
    threshold: options.threshold,
  });

  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const outputs = history.outputs?.['13']?.mesh;
  if (!outputs || !outputs.length) {
    throw new Error('TripoSR completed execution without producing any 3D mesh output.');
  }

  const objFilename = outputs[0].filename as string;
  const objPath = join(installation.outputDir, objFilename);
  const glbPath = objPath.replace(/\.obj$/i, '.glb');

  const stats = await convertObjToGlb(objPath, glbPath);
  const glbBuffer = readFileSync(glbPath);

  return {
    glbBuffer,
    stats,
    objFilename,
  };
}

export async function executeSdxlTxt2Img(
  params: SdxlTxt2ImgParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildSdxlTxt2ImgWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['9']?.images;
  if (!images || !images.length) {
    throw new Error('SDXL image generation completed without producing image output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`Generated image not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return { filename, localPath, buffer };
}

export async function executeSdxlImg2Img(
  params: SdxlImg2ImgParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildSdxlImg2ImgWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['9']?.images;
  if (!images || !images.length) {
    throw new Error('SDXL img2img revision completed without producing image output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`Revised image not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return { filename, localPath, buffer };
}

export async function executeSdxlInpaint(
  params: SdxlInpaintParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildSdxlInpaintWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['9']?.images;
  if (!images || !images.length) {
    throw new Error('SDXL inpainting completed without producing image output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`Inpainted image not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return { filename, localPath, buffer };
}

export async function executeLtxImg2Vid(
  params: LtxImg2VidParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildLtxImg2VidWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['8']?.images;
  if (!images || !images.length) {
    throw new Error('LTX video generation completed without producing video frames/output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`Generated video not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return { filename, localPath, buffer };
}

export async function executeWanTxt2Vid(
  params: WanTxt2VidParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildWanTxt2VidWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['7']?.images;
  if (!images || !images.length) {
    throw new Error('Wan T2V video generation completed without producing video output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`Generated video not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return { filename, localPath, buffer };
}

export async function executeWanImg2Vid(
  params: WanImg2VidParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildWanImg2VidWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['8']?.images;
  if (!images || !images.length) {
    throw new Error('Wan I2V video generation completed without producing video output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`Generated video not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return { filename, localPath, buffer };
}

export async function executeSdxlIpAdapter(
  params: SdxlIpAdapterParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildSdxlIpAdapterWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['11']?.images;
  if (!images || !images.length) {
    throw new Error('SDXL IP-Adapter generation completed without producing image output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`IP-Adapter output image not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return { filename, localPath, buffer };
}

export async function executeFluxTxt2Img(
  params: FluxTxt2ImgParams,
  endpoint = getComfyUrl()
): Promise<{ filename: string; localPath: string; buffer: Buffer }> {
  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory could not be located on this system.');
  }

  const workflow = buildFluxTxt2ImgWorkflow(params);
  const { promptId } = await submitComfyPrompt(workflow, endpoint);
  const history = await pollComfyHistory(promptId, 300000, endpoint);

  const images = history.outputs?.['10']?.images;
  if (!images || !images.length) {
    throw new Error('FLUX text-to-image generation completed without producing image output.');
  }

  const filename = images[0].filename as string;
  const subfolder = images[0].subfolder || '';
  const localPath = join(installation.outputDir, subfolder, filename);

  if (!existsSync(localPath)) {
    throw new Error(`FLUX output image not found at expected path: ${localPath}`);
  }

  const buffer = readFileSync(localPath);
  return { filename, localPath, buffer };
}



