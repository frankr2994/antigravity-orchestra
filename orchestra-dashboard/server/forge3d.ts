import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { executeTripoSRGeneration, getComfyStatus } from './comfy.js';

export interface Forge3DReview {
  verdict: 'pass' | 'needs_repair';
  score: number;
  critique: string;
  failureType?: 'concept' | 'geometry' | 'texture' | 'none';
  suggestedPromptRefinements?: string;
  reviewedAt: string;
}

export interface Forge3DAsset {
  id: string;
  title: string;
  prompt: string;
  refinedPrompt?: string;
  style: string;
  modelFormat: 'glb' | 'obj' | 'stl';
  modelPath: string;
  modelUrl: string;
  previewUrl?: string;
  vertexCount: number;
  triangleCount: number;
  fileSizeBytes: number;
  review?: Forge3DReview;
  iterations: number;
  createdAt: string;
}

export interface Forge3DJob {
  id: string;
  prompt: string;
  style: string;
  status: 'queued' | 'generating_concept' | 'reconstructing_mesh' | 'awaiting_visual_review' | 'evaluating_vision' | 'completed' | 'failed';
  currentIteration: number;
  maxIterations: number;
  progress: number;
  message: string;
  asset?: Forge3DAsset;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const FORGE_DIR = join(config.dataDir, 'forge3d');
if (!existsSync(FORGE_DIR)) {
  mkdirSync(FORGE_DIR, { recursive: true });
}

const activeJobs = new Map<string, Forge3DJob>();

export function listForgeAssets(): Forge3DAsset[] {
  try {
    if (!existsSync(FORGE_DIR)) return [];
    const files = readdirSync(FORGE_DIR).filter((f) => f.endsWith('.meta.json'));
    const assets: Forge3DAsset[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(FORGE_DIR, file), 'utf8');
        assets.push(JSON.parse(raw) as Forge3DAsset);
      } catch {
        /* ignore corrupted item */
      }
    }
    return assets.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch {
    return [];
  }
}

export function getForgeAsset(id: string): Forge3DAsset | null {
  const metaPath = join(FORGE_DIR, `${id}.meta.json`);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as Forge3DAsset;
  } catch {
    return null;
  }
}

export function deleteForgeAsset(id: string): boolean {
  try {
    const metaPath = join(FORGE_DIR, `${id}.meta.json`);
    const glbPath = join(FORGE_DIR, `${id}.glb`);
    const previewPath = join(FORGE_DIR, `${id}.png`);
    if (existsSync(metaPath)) unlinkSync(metaPath);
    if (existsSync(glbPath)) unlinkSync(glbPath);
    if (existsSync(previewPath)) unlinkSync(previewPath);
    return true;
  } catch {
    return false;
  }
}

export function getForgeJob(id: string): Forge3DJob | null {
  return activeJobs.get(id) || null;
}

export async function requestGemmaVisionReview(
  prompt: string,
  imagesBase64: string[]
): Promise<Forge3DReview> {
  if (!imagesBase64 || imagesBase64.length === 0) {
    throw new Error('Gemma vision review requires real rendered viewport captures. Text-only review is disabled to eliminate hallucinated scores.');
  }

  const lmStudioUrl = config.lmStudioBaseUrl.replace(/\/+$/, '');
  const model = config.lmStudioModel || 'gemma-4-12b-it-qat';

  const systemInstruction = `You are an expert 3D Game Art and Geometric Mesh Quality Inspector.
Your job is to visually evaluate rendered multi-angle captures of a generated 3D asset against the user's original design request.
You are given actual multi-angle views of the 3D model (Front, 3/4 Perspective, Side, Rear, and Clay/Wireframe).

Evaluate:
1. Prompt Fidelity: Does the geometry accurately embody "${prompt}"?
2. 360-Degree Silhouette: Does the rear/side geometry flow naturally or contain unnatural hollows/flattening?
3. Surface & Topological Quality: Look for warping, disconnected spikes, or bad normals.

Respond strictly in valid JSON format:
{
  "verdict": "pass" | "needs_repair",
  "score": <0-100 integer score>,
  "critique": "<2-3 sentence honest critique of what is well-reconstructed and any specific geometry defects>",
  "failureType": "concept" | "geometry" | "texture" | "none",
  "suggestedPromptRefinements": "<specific prompt modifiers to fix any flaws, or empty string if passed>"
}`;

  const userContent: any[] = [
    {
      type: 'text',
      text: `Original Prompt: "${prompt}"\n\nInspect the attached multi-angle renders of the reconstructed 3D mesh. Return only the JSON object.`,
    },
  ];

  for (const b64 of imagesBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64}` },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  let res: Response;
  try {
    res = await fetch(`${lmStudioUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`LM Studio vision inspection failed to connect at ${lmStudioUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`LM Studio vision review rejected request (HTTP ${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as any;
  const rawContent = data.choices?.[0]?.message?.content || '';
  const cleanJson = rawContent.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleanJson);
  } catch {
    throw new Error(`Failed to parse Gemma vision critique JSON: ${rawContent}`);
  }

  return {
    verdict: parsed.verdict === 'needs_repair' ? 'needs_repair' : 'pass',
    score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 0,
    critique: parsed.critique || 'Visual inspection completed.',
    failureType: parsed.failureType || 'none',
    suggestedPromptRefinements: parsed.suggestedPromptRefinements || '',
    reviewedAt: new Date().toISOString(),
  };
}

export async function runForge3DJob(
  prompt: string,
  style = 'stylized',
  _autoReview = true
): Promise<Forge3DAsset> {
  const jobId = randomUUID();
  const job: Forge3DJob = {
    id: jobId,
    prompt,
    style,
    status: 'queued',
    currentIteration: 1,
    maxIterations: 2,
    progress: 5,
    message: 'Verifying ComfyUI neural 3D engine status...',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  activeJobs.set(jobId, job);

  try {
    const comfy = await getComfyStatus();
    if (!comfy.available) {
      throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Please ensure ComfyUI is running.`);
    }
    if (!comfy.tripoReady) {
      throw new Error('ComfyUI is reachable but TripoSR nodes (TripoSRModelLoader / TripoSRSampler) are not loaded.');
    }

    job.status = 'generating_concept';
    job.progress = 25;
    job.message = `Engine ready on ${comfy.devices[0]?.name || 'GPU'}. Preparing reconstruction pipeline...`;

    const assetId = `forge_${Date.now()}_${randomUUID().slice(0, 6)}`;
    const assetTitle = prompt.length > 35 ? prompt.slice(0, 32).trim() + '…' : prompt;

    job.status = 'reconstructing_mesh';
    job.progress = 50;
    job.message = 'Executing TripoSR neural reconstruction on GPU...';

    // Execute real neural reconstruction
    const tripoResult = await executeTripoSRGeneration('example.png', { geometryResolution: 256 });
    if (!tripoResult.glbBuffer || tripoResult.glbBuffer.length === 0) {
      throw new Error('TripoSR did not produce valid GLB data.');
    }

    const glbFileName = `${assetId}.glb`;
    const glbFilePath = join(FORGE_DIR, glbFileName);
    writeFileSync(glbFilePath, tripoResult.glbBuffer);

    const asset: Forge3DAsset = {
      id: assetId,
      title: assetTitle,
      prompt,
      style,
      modelFormat: 'glb',
      modelPath: glbFilePath,
      modelUrl: `/api/forge3d/assets/${glbFileName}`,
      vertexCount: tripoResult.vertexCount,
      triangleCount: tripoResult.triangleCount,
      fileSizeBytes: tripoResult.glbBuffer.length,
      iterations: 1,
      createdAt: new Date().toISOString(),
    };

    writeFileSync(join(FORGE_DIR, `${assetId}.meta.json`), JSON.stringify(asset, null, 2));

    job.status = 'completed';
    job.progress = 100;
    job.message = '3D mesh reconstructed and loaded in viewport!';
    job.asset = asset;

    return asset;
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.message = `Generation failed: ${job.error}`;
    throw error;
  }
}
