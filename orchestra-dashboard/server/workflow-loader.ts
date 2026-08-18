import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = typeof __dirname !== 'undefined'
  ? __dirname
  : join(fileURLToPath(import.meta.url), '..');

const WORKFLOWS_DIR = existsSync(join(currentDir, 'workflows'))
  ? join(currentDir, 'workflows')
  : join(process.cwd(), 'server', 'workflows');

export interface ConceptGenParams {
  prompt: string;
  negativePrompt?: string;
  ckptName?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  samplerName?: string;
  scheduler?: string;
}

export interface TripoSRParams {
  imageName: string;
  modelName?: string;
  geometryResolution?: number;
  threshold?: number;
  chunkSize?: number;
}

export interface SdxlTxt2ImgParams {
  prompt: string;
  negativePrompt?: string;
  ckptName?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  samplerName?: string;
  scheduler?: string;
  denoise?: number;
}

export interface SdxlImg2ImgParams extends SdxlTxt2ImgParams {
  sourceImage: string;
  denoise?: number;
}

export interface SdxlInpaintParams extends SdxlTxt2ImgParams {
  sourceImage: string;
  maskImage: string;
  denoise?: number;
}

export interface SdxlIpAdapterParams extends SdxlTxt2ImgParams {
  referenceImage: string;
  ipAdapterWeight?: number;
  clipVisionModel?: string;
  ipAdapterModel?: string;
}

export interface LtxImg2VidParams {
  sourceImage: string;
  prompt?: string;
  negativePrompt?: string;
  ckptName?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  fps?: number;
  denoise?: number;
}

export interface WanTxt2VidParams {
  prompt: string;
  negativePrompt?: string;
  ckptName?: string;
  width?: number;
  height?: number;
  length?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  fps?: number;
}

export interface WanImg2VidParams {
  sourceImage: string;
  prompt?: string;
  negativePrompt?: string;
  ckptName?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  fps?: number;
}

function loadWorkflowJson(filename: string): Record<string, any> {
  const filePath = join(WORKFLOWS_DIR, filename);
  if (!existsSync(filePath)) {
    throw new Error(`Workflow template not found at ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function buildConceptGenerationWorkflow(params: ConceptGenParams): Record<string, any> {
  const workflow = loadWorkflowJson('concept-gen.json');

  // Node 6: Positive prompt
  if (workflow['6']?.inputs) {
    workflow['6'].inputs.text = params.prompt.trim();
  }

  // Node 7: Negative prompt
  if (workflow['7']?.inputs) {
    const defaultNegative =
      'ugly, deformed, noisy, blurry, distorted, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, cropped, worst quality, jpeg artifacts, watermark, signature';
    workflow['7'].inputs.text = params.negativePrompt ? `${params.negativePrompt}, ${defaultNegative}` : defaultNegative;
  }

  // Node 4: Checkpoint
  if (workflow['4']?.inputs && params.ckptName) {
    workflow['4'].inputs.ckpt_name = params.ckptName;
  }

  // Node 5: Latent Dimensions
  if (workflow['5']?.inputs) {
    if (params.width) workflow['5'].inputs.width = params.width;
    if (params.height) workflow['5'].inputs.height = params.height;
  }

  // Node 3: KSampler
  if (workflow['3']?.inputs) {
    workflow['3'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['3'].inputs.steps = params.steps;
    if (params.cfg) workflow['3'].inputs.cfg = params.cfg;
    if (params.samplerName) workflow['3'].inputs.sampler_name = params.samplerName;
    if (params.scheduler) workflow['3'].inputs.scheduler = params.scheduler;
  }

  return workflow;
}

export function buildTripoSRWorkflow(params: TripoSRParams): Record<string, any> {
  const workflow = loadWorkflowJson('forge3d-triposr.json');

  // Node 15: LoadImage
  if (workflow['15']?.inputs) {
    workflow['15'].inputs.image = params.imageName;
  }

  // Node 14: Model loader
  if (workflow['14']?.inputs) {
    if (params.modelName) workflow['14'].inputs.model = params.modelName;
    if (params.chunkSize) workflow['14'].inputs.chunk_size = params.chunkSize;
  }

  // Node 12: Sampler
  if (workflow['12']?.inputs) {
    if (params.geometryResolution) workflow['12'].inputs.geometry_resolution = params.geometryResolution;
    if (params.threshold) workflow['12'].inputs.threshold = params.threshold;
  }

  return workflow;
}

export function buildSdxlTxt2ImgWorkflow(params: SdxlTxt2ImgParams): Record<string, any> {
  const workflow = loadWorkflowJson('sdxl-txt2img.json');

  if (workflow['4']?.inputs && params.ckptName) {
    workflow['4'].inputs.ckpt_name = params.ckptName;
  }

  if (workflow['5']?.inputs) {
    if (params.width) workflow['5'].inputs.width = params.width;
    if (params.height) workflow['5'].inputs.height = params.height;
  }

  if (workflow['6']?.inputs) {
    workflow['6'].inputs.text = params.prompt.trim();
  }

  if (workflow['7']?.inputs) {
    const defaultNegative = 'blurry, low quality, distorted, artifacts, extra limbs, bad anatomy, watermark, signature';
    workflow['7'].inputs.text = params.negativePrompt ? `${params.negativePrompt}, ${defaultNegative}` : defaultNegative;
  }

  if (workflow['3']?.inputs) {
    workflow['3'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['3'].inputs.steps = params.steps;
    if (params.cfg) workflow['3'].inputs.cfg = params.cfg;
    if (params.samplerName) workflow['3'].inputs.sampler_name = params.samplerName;
    if (params.scheduler) workflow['3'].inputs.scheduler = params.scheduler;
    if (typeof params.denoise === 'number') workflow['3'].inputs.denoise = params.denoise;
  }

  return workflow;
}

export function buildSdxlImg2ImgWorkflow(params: SdxlImg2ImgParams): Record<string, any> {
  const workflow = loadWorkflowJson('sdxl-img2img.json');

  if (workflow['1']?.inputs) {
    workflow['1'].inputs.image = params.sourceImage;
  }

  if (workflow['4']?.inputs && params.ckptName) {
    workflow['4'].inputs.ckpt_name = params.ckptName;
  }

  if (workflow['6']?.inputs) {
    workflow['6'].inputs.text = params.prompt.trim();
  }

  if (workflow['7']?.inputs) {
    const defaultNegative = 'blurry, low quality, distorted, artifacts, text, watermark';
    workflow['7'].inputs.text = params.negativePrompt ? `${params.negativePrompt}, ${defaultNegative}` : defaultNegative;
  }

  if (workflow['3']?.inputs) {
    workflow['3'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['3'].inputs.steps = params.steps;
    if (params.cfg) workflow['3'].inputs.cfg = params.cfg;
    if (params.samplerName) workflow['3'].inputs.sampler_name = params.samplerName;
    if (params.scheduler) workflow['3'].inputs.scheduler = params.scheduler;
    workflow['3'].inputs.denoise = typeof params.denoise === 'number' ? params.denoise : 0.45;
  }

  return workflow;
}

export function buildSdxlInpaintWorkflow(params: SdxlInpaintParams): Record<string, any> {
  const workflow = loadWorkflowJson('sdxl-inpaint.json');

  if (workflow['1']?.inputs) {
    workflow['1'].inputs.image = params.sourceImage;
  }

  if (workflow['2']?.inputs) {
    workflow['2'].inputs.image = params.maskImage;
  }

  if (workflow['4']?.inputs && params.ckptName) {
    workflow['4'].inputs.ckpt_name = params.ckptName;
  }

  if (workflow['6']?.inputs) {
    workflow['6'].inputs.text = params.prompt.trim();
  }

  if (workflow['7']?.inputs) {
    const defaultNegative = 'blurry, low quality, distorted, artifacts, seams, watermark';
    workflow['7'].inputs.text = params.negativePrompt ? `${params.negativePrompt}, ${defaultNegative}` : defaultNegative;
  }

  if (workflow['3']?.inputs) {
    workflow['3'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['3'].inputs.steps = params.steps;
    if (params.cfg) workflow['3'].inputs.cfg = params.cfg;
    if (params.samplerName) workflow['3'].inputs.sampler_name = params.samplerName;
    if (params.scheduler) workflow['3'].inputs.scheduler = params.scheduler;
    workflow['3'].inputs.denoise = typeof params.denoise === 'number' ? params.denoise : 0.85;
  }

  return workflow;
}

export function buildLtxImg2VidWorkflow(params: LtxImg2VidParams): Record<string, any> {
  const workflow = loadWorkflowJson('ltx-img2vid.json');

  if (workflow['1']?.inputs) {
    workflow['1'].inputs.image = params.sourceImage;
  }

  if (workflow['2']?.inputs && params.ckptName) {
    workflow['2'].inputs.ckpt_name = params.ckptName;
  }

  if (workflow['4']?.inputs && params.prompt) {
    workflow['4'].inputs.text = params.prompt.trim();
  }

  if (workflow['5']?.inputs && params.negativePrompt) {
    workflow['5'].inputs.text = params.negativePrompt.trim();
  }

  if (workflow['6']?.inputs) {
    workflow['6'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['6'].inputs.steps = params.steps;
    if (params.cfg) workflow['6'].inputs.cfg = params.cfg;
    if (typeof params.denoise === 'number') workflow['6'].inputs.denoise = params.denoise;
  }

  if (workflow['8']?.inputs && params.fps) {
    workflow['8'].inputs.fps = params.fps;
  }

  return workflow;
}

export function buildWanTxt2VidWorkflow(params: WanTxt2VidParams): Record<string, any> {
  const workflow = loadWorkflowJson('wan21-txt2vid.json');

  if (workflow['1']?.inputs && params.ckptName) {
    workflow['1'].inputs.ckpt_name = params.ckptName;
  }

  if (workflow['2']?.inputs) {
    if (params.width) workflow['2'].inputs.width = params.width;
    if (params.height) workflow['2'].inputs.height = params.height;
    if (params.length) workflow['2'].inputs.length = params.length;
  }

  if (workflow['3']?.inputs) {
    workflow['3'].inputs.text = params.prompt.trim();
  }

  if (workflow['4']?.inputs && params.negativePrompt) {
    workflow['4'].inputs.text = params.negativePrompt.trim();
  }

  if (workflow['5']?.inputs) {
    workflow['5'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['5'].inputs.steps = params.steps;
    if (params.cfg) workflow['5'].inputs.cfg = params.cfg;
  }

  if (workflow['7']?.inputs && params.fps) {
    workflow['7'].inputs.fps = params.fps;
  }

  return workflow;
}

export function buildWanImg2VidWorkflow(params: WanImg2VidParams): Record<string, any> {
  const workflow = loadWorkflowJson('wan21-img2vid.json');

  if (workflow['1']?.inputs) {
    workflow['1'].inputs.image = params.sourceImage;
  }

  if (workflow['2']?.inputs && params.ckptName) {
    workflow['2'].inputs.ckpt_name = params.ckptName;
  }

  if (workflow['4']?.inputs && params.prompt) {
    workflow['4'].inputs.text = params.prompt.trim();
  }

  if (workflow['5']?.inputs && params.negativePrompt) {
    workflow['5'].inputs.text = params.negativePrompt.trim();
  }

  if (workflow['6']?.inputs) {
    workflow['6'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['6'].inputs.steps = params.steps;
    if (params.cfg) workflow['6'].inputs.cfg = params.cfg;
  }

  if (workflow['8']?.inputs && params.fps) {
    workflow['8'].inputs.fps = params.fps;
  }

  return workflow;
}

export function buildSdxlIpAdapterWorkflow(params: SdxlIpAdapterParams): Record<string, any> {
  const workflow = loadWorkflowJson('sdxl-ipadapter.json');

  if (workflow['1']?.inputs) {
    workflow['1'].inputs.image = params.referenceImage;
  }

  if (workflow['2']?.inputs && params.clipVisionModel) {
    workflow['2'].inputs.clip_name = params.clipVisionModel;
  }

  if (workflow['3']?.inputs && params.ipAdapterModel) {
    workflow['3'].inputs.ipadapter_file = params.ipAdapterModel;
  }

  if (workflow['4']?.inputs && params.ckptName) {
    workflow['4'].inputs.ckpt_name = params.ckptName;
  }

  if (workflow['5']?.inputs && typeof params.ipAdapterWeight === 'number') {
    workflow['5'].inputs.weight = params.ipAdapterWeight;
  }

  if (workflow['6']?.inputs) {
    if (params.width) workflow['6'].inputs.width = params.width;
    if (params.height) workflow['6'].inputs.height = params.height;
  }

  if (workflow['7']?.inputs) {
    workflow['7'].inputs.text = params.prompt.trim();
  }

  if (workflow['8']?.inputs) {
    const defaultNegative = 'blurry, low quality, distorted, bad anatomy, extra limbs, watermark';
    workflow['8'].inputs.text = params.negativePrompt ? `${params.negativePrompt}, ${defaultNegative}` : defaultNegative;
  }

  if (workflow['9']?.inputs) {
    workflow['9'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['9'].inputs.steps = params.steps;
    if (params.cfg) workflow['9'].inputs.cfg = params.cfg;
    if (params.samplerName) workflow['9'].inputs.sampler_name = params.samplerName;
    if (params.scheduler) workflow['9'].inputs.scheduler = params.scheduler;
    if (typeof params.denoise === 'number') workflow['9'].inputs.denoise = params.denoise;
  }

  return workflow;
}

export interface FluxTxt2ImgParams {
  prompt: string;
  negativePrompt?: string;
  unetName?: string;
  clip1?: string;
  clip2?: string;
  vaeName?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  samplerName?: string;
  scheduler?: string;
  seed?: number;
}

export function buildFluxTxt2ImgWorkflow(params: FluxTxt2ImgParams): Record<string, any> {
  const workflow = loadWorkflowJson('flux-txt2img.json');

  if (workflow['1']?.inputs && params.unetName) {
    if ('ckpt_name' in workflow['1'].inputs) {
      workflow['1'].inputs.ckpt_name = params.unetName;
    } else {
      workflow['1'].inputs.unet_name = params.unetName;
    }
  }
  if (workflow['2']?.inputs) {
    if (params.clip1) workflow['2'].inputs.clip_name1 = params.clip1;
    if (params.clip2) workflow['2'].inputs.clip_name2 = params.clip2;
  }
  if (workflow['3']?.inputs && params.vaeName) {
    workflow['3'].inputs.vae_name = params.vaeName;
  }
  if (workflow['4']?.inputs && typeof params.guidance === 'number') {
    workflow['4'].inputs.guidance = params.guidance;
  }
  if (workflow['5']?.inputs) {
    workflow['5'].inputs.text = params.prompt.trim();
  }
  if (workflow['6']?.inputs && params.negativePrompt) {
    workflow['6'].inputs.text = params.negativePrompt.trim();
  }
  if (workflow['7']?.inputs) {
    if (params.width) workflow['7'].inputs.width = params.width;
    if (params.height) workflow['7'].inputs.height = params.height;
  }
  if (workflow['8']?.inputs) {
    workflow['8'].inputs.seed = params.seed ?? Math.floor(Math.random() * 1000000000000);
    if (params.steps) workflow['8'].inputs.steps = params.steps;
    if (params.samplerName) workflow['8'].inputs.sampler_name = params.samplerName;
    if (params.scheduler) workflow['8'].inputs.scheduler = params.scheduler;
  }

  return workflow;
}

