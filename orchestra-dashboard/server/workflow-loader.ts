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
    const basePrompt = params.prompt.trim();
    workflow['6'].inputs.text = `a high quality 3D asset of ${basePrompt}, full view, centered, clean white background, soft studio lighting, sharp details`;
  }

  // Node 7: Negative prompt
  if (workflow['7']?.inputs) {
    const defaultNegative = 'table, desk, surface, floor, shadow on ground, flat 2d, illustration, room, background clutter, multiple objects, human hands, cropped, blurry, cut off, transparency grid, watermark, text, logo';
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
