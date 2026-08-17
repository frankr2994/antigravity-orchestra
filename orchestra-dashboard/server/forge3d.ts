import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { executeConceptGeneration, executeTripoSRGeneration, findComfyInstallation, getComfyStatus } from './comfy.js';
import { stageGpuForStep } from './gpu-manager.js';
import type { MeshBoundingBox } from './mesh-qa.js';
import { preprocessImageForTripo } from './rembg-processor.js';
import { checkForgeDependencies } from './forge-manifest.js';

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
  mode: 'text_to_3d' | 'image_to_3d';
  modelFormat: 'glb' | 'obj' | 'stl';
  modelPath: string;
  modelUrl: string;
  previewUrl?: string;
  vertexCount: number;
  triangleCount: number;
  isWatertight?: boolean;
  surfaceArea?: number;
  eulerNumber?: number;
  boundingBox?: MeshBoundingBox;
  fileSizeBytes: number;
  review?: Forge3DReview;
  iterations: number;
  createdAt: string;
}

export interface Forge3DJob {
  id: string;
  prompt: string;
  style: string;
  mode: 'text_to_3d' | 'image_to_3d';
  status: 'queued' | 'generating_concept' | 'staging_gpu' | 'reconstructing_mesh' | 'awaiting_visual_review' | 'evaluating_vision' | 'completed' | 'failed';
  currentIteration: number;
  maxIterations: number;
  progress: number;
  message: string;
  asset?: Forge3DAsset;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Forge3DGenerateOptions {
  prompt?: string;
  imageFilename?: string;
  imageBuffer?: Buffer;
  style?: string;
  autoReview?: boolean;
  mode?: 'text_to_3d' | 'image_to_3d';
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
    const rawPath = join(FORGE_DIR, `${id}_raw.png`);
    if (existsSync(metaPath)) unlinkSync(metaPath);
    if (existsSync(glbPath)) unlinkSync(glbPath);
    if (existsSync(previewPath)) unlinkSync(previewPath);
    if (existsSync(rawPath)) unlinkSync(rawPath);
    return true;
  } catch {
    return false;
  }
}

export function getForgeJob(id: string): Forge3DJob | null {
  return activeJobs.get(id) || null;
}

let cachedVisionProbe: { result: { available: boolean; model: string; isMultimodal: boolean; error?: string }; expiresAt: number } | null = null;

export async function probeLmStudioStatus(): Promise<{
  available: boolean;
  model: string;
  isMultimodal: boolean;
  error?: string;
}> {
  const now = Date.now();
  if (cachedVisionProbe && cachedVisionProbe.expiresAt > now) {
    return cachedVisionProbe.result;
  }

  const lmStudioUrl = config.lmStudioBaseUrl.replace(/\/+$/, '');
  const expectedModel = config.lmStudioModel || 'gemma-4-12b-it-qat';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const modelsRes = await fetch(`${lmStudioUrl}/models`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!modelsRes.ok) {
      const res = { available: false, model: expectedModel, isMultimodal: false, error: `HTTP ${modelsRes.status}` };
      cachedVisionProbe = { result: res, expiresAt: now + 5000 };
      return res;
    }

    const data = (await modelsRes.json()) as any;
    const models = Array.isArray(data.data) ? data.data.map((m: any) => m.id) : [];
    const loadedModel = models.find((m: string) => m.toLowerCase().includes('gemma') || m === expectedModel) || models[0] || expectedModel;

    // Genuine Semantic Visual Recognition Probe: Send a 4x4 pure red image and ask for color identification
    const probeController = new AbortController();
    const probeTimeout = setTimeout(() => probeController.abort(), 4000);

    let isMultimodal = false;
    let probeError: string | undefined;

    try {
      const chatRes = await fetch(`${lmStudioUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: loadedModel,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What color is this image? Reply with only the single color name (e.g. red, blue, green).' },
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAD0lEQVR42mP8z8AARAwMAGsgBP7qZ7vUAAAAAElFTkSuQmCC' },
                },
              ],
            },
          ],
          max_tokens: 5,
          temperature: 0.0,
        }),
        signal: probeController.signal,
      });

      clearTimeout(probeTimeout);
      if (chatRes.ok) {
        const chatData = (await chatRes.json()) as any;
        const text = chatData.choices?.[0]?.message?.content || '';
        if (/red/i.test(text)) {
          isMultimodal = true;
        } else {
          isMultimodal = false;
          probeError = `Model did not visually identify red image (replied: "${text.trim()}"). Ensure a vision model is active.`;
        }
      } else {
        const errText = await chatRes.text();
        isMultimodal = false;
        probeError = `Loaded model rejected vision input: ${errText.slice(0, 100)}`;
      }
    } catch (chatErr) {
      clearTimeout(probeTimeout);
      isMultimodal = false;
      probeError = `Vision interpretation probe timed out or failed: ${chatErr instanceof Error ? chatErr.message : String(chatErr)}`;
    }

    const result = {
      available: true,
      model: loadedModel,
      isMultimodal,
      error: probeError,
    };
    cachedVisionProbe = { result, expiresAt: now + 15000 };
    return result;
  } catch (err) {
    const result = {
      available: false,
      model: expectedModel,
      isMultimodal: false,
      error: err instanceof Error ? err.message : String(err),
    };
    cachedVisionProbe = { result, expiresAt: now + 5000 };
    return result;
  }
}

export async function requestGemmaVisionReview(
  prompt: string,
  imagesBase64: string[]
): Promise<Forge3DReview> {
  if (!imagesBase64 || imagesBase64.length === 0) {
    throw new Error('Gemma vision review requires real rendered viewport captures. Text-only review is disabled to eliminate hallucinated scores.');
  }

  // Free TripoSR/Comfy VRAM before invoking Gemma 12B Vision
  await stageGpuForStep('vision');

  const lmStudioUrl = config.lmStudioBaseUrl.replace(/\/+$/, '');
  const model = config.lmStudioModel || 'gemma-4-12b-it-qat';

  const systemInstruction = `You are an expert 3D Game Art and Geometric Mesh Quality Inspector.
Your job is to visually evaluate rendered diagnostic captures of a reconstructed 3D asset against the user's design request.
You are given 6 standardized deterministic diagnostic views of the 3D model:
1. Front Shaded (0°)
2. 3/4 Iso Perspective Shaded (45°)
3. Side Profile Shaded (90°)
4. Rear Shaded (180°)
5. 3/4 Iso Clay Surface (45° neutral material)
6. 3/4 Iso Wireframe (45° topological structure)

Evaluate:
1. Prompt Fidelity: Does the geometry accurately embody "${prompt}"?
2. 360-Degree Silhouette: Does the rear/side geometry flow naturally or contain unnatural hollows/flattening?
3. Surface & Topological Quality: Check the clay and wireframe renders for surface pinch, spikes, or bad normals.

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
      text: `Original Prompt: "${prompt}"\n\nInspect the attached 6 standardized multi-angle diagnostic renders. Return only the JSON object.`,
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

export async function reviewForgeAsset(
  id: string,
  imagesBase64: string[]
): Promise<Forge3DReview> {
  const asset = getForgeAsset(id);
  if (!asset) {
    throw new Error(`Asset not found with ID ${id}`);
  }

  const review = await requestGemmaVisionReview(asset.prompt, imagesBase64);
  asset.review = review;

  const metaPath = join(FORGE_DIR, `${id}.meta.json`);
  writeFileSync(metaPath, JSON.stringify(asset, null, 2));

  return review;
}

export async function repairForgeAsset(id: string): Promise<Forge3DAsset> {
  const asset = getForgeAsset(id);
  if (!asset) {
    throw new Error(`Asset not found with ID ${id}`);
  }

  if (asset.iterations >= 3) {
    throw new Error(`Asset ${id} has reached maximum repair limit of 3 iterations.`);
  }

  const failureType = asset.review?.failureType || 'geometry';
  const refinement = asset.review?.suggestedPromptRefinements || '';

  const installation = findComfyInstallation();
  if (!installation) {
    throw new Error('ComfyUI installation directory not found.');
  }

  let repairedAsset: Forge3DAsset;
  const nextIteration = asset.iterations + 1;

  // Progressive Resolution Escalation: 256 (initial) -> 384 (Repair #1) -> 512 (Repair #2)
  const targetResolution = nextIteration >= 3 ? 512 : 384;
  const targetThreshold = nextIteration >= 3 ? 30.0 : 28.0;

  if (failureType === 'concept' && asset.mode === 'text_to_3d') {
    // 1. Text-to-3D Concept failure: Regenerate 2D concept with refined prompt
    const updatedPrompt = refinement ? `${asset.prompt}, ${refinement}` : `${asset.prompt}, clean sharp edges, high contrast`;
    await stageGpuForStep('concept');

    const concept = await executeConceptGeneration({
      prompt: updatedPrompt,
      steps: 25,
      cfg: 8.0,
      width: 512,
      height: 512,
    });

    const rawConceptPath = join(FORGE_DIR, `${asset.id}_raw.png`);
    writeFileSync(rawConceptPath, concept.buffer);

    const processedPath = join(FORGE_DIR, `${asset.id}.png`);
    const prep = await preprocessImageForTripo(rawConceptPath, processedPath);
    if (!prep.success) {
      throw new Error(`TripoSR repair concept preprocessing failed: ${prep.error || 'Foreground segmentation failed'}`);
    }

    const inputFilename = `${asset.id}_iter${nextIteration}.png`;
    const comfyInputTarget = join(installation.inputDir, inputFilename);
    copyFileSync(processedPath, comfyInputTarget);

    await stageGpuForStep('reconstruction');
    const tripoResult = await executeTripoSRGeneration(inputFilename, {
      geometryResolution: targetResolution,
      threshold: targetThreshold,
    });

    const glbFileName = `${asset.id}.glb`;
    const glbFilePath = join(FORGE_DIR, glbFileName);
    writeFileSync(glbFilePath, tripoResult.glbBuffer);

    repairedAsset = {
      ...asset,
      refinedPrompt: updatedPrompt,
      previewUrl: `/api/forge3d/assets/${asset.id}.png`,
      vertexCount: tripoResult.stats.vertexCount,
      triangleCount: tripoResult.stats.triangleCount,
      isWatertight: tripoResult.stats.isWatertight,
      surfaceArea: tripoResult.stats.surfaceArea,
      eulerNumber: tripoResult.stats.eulerNumber,
      boundingBox: tripoResult.stats.boundingBox,
      fileSizeBytes: tripoResult.glbBuffer.length,
      iterations: nextIteration,
      review: undefined,
    };
  } else {
    // 2. Geometry / Mesh failure OR Image-to-3D:
    // CRITICAL: NEVER replace a user's uploaded photograph with SD AI output.
    // Preserve existing source concept image and escalate reconstruction resolution.
    const existingConceptPath = join(FORGE_DIR, `${asset.id}.png`);
    if (!existsSync(existingConceptPath)) {
      throw new Error(`Cannot perform repair: Source image not found at ${existingConceptPath}`);
    }

    const inputFilename = `${asset.id}_iter${nextIteration}.png`;
    const comfyInputTarget = join(installation.inputDir, inputFilename);
    copyFileSync(existingConceptPath, comfyInputTarget);

    await stageGpuForStep('reconstruction');
    const tripoResult = await executeTripoSRGeneration(inputFilename, {
      geometryResolution: targetResolution,
      threshold: targetThreshold,
    });

    const glbFileName = `${asset.id}.glb`;
    const glbFilePath = join(FORGE_DIR, glbFileName);
    writeFileSync(glbFilePath, tripoResult.glbBuffer);

    repairedAsset = {
      ...asset,
      vertexCount: tripoResult.stats.vertexCount,
      triangleCount: tripoResult.stats.triangleCount,
      isWatertight: tripoResult.stats.isWatertight,
      surfaceArea: tripoResult.stats.surfaceArea,
      eulerNumber: tripoResult.stats.eulerNumber,
      boundingBox: tripoResult.stats.boundingBox,
      fileSizeBytes: tripoResult.glbBuffer.length,
      iterations: nextIteration,
      review: undefined,
    };
  }

  const metaPath = join(FORGE_DIR, `${id}.meta.json`);
  writeFileSync(metaPath, JSON.stringify(repairedAsset, null, 2));

  return repairedAsset;
}

export async function runForge3DJob(
  input: string | Forge3DGenerateOptions,
  styleArg = 'stylized',
  _autoReviewArg = true
): Promise<Forge3DAsset> {
  const options: Forge3DGenerateOptions = typeof input === 'string'
    ? { prompt: input, style: styleArg, autoReview: _autoReviewArg, mode: 'text_to_3d' }
    : { mode: 'text_to_3d', style: 'stylized', autoReview: true, ...input };

  const mode = options.mode || (options.imageFilename ? 'image_to_3d' : 'text_to_3d');
  const prompt = (options.prompt || '').trim();
  const style = options.style || 'stylized';

  const jobId = randomUUID();
  const job: Forge3DJob = {
    id: jobId,
    prompt: prompt || (options.imageFilename ? `Image: ${options.imageFilename}` : '3D Generation'),
    style,
    mode,
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
    const installation = findComfyInstallation();
    if (!installation) {
      throw new Error('ComfyUI installation directory not found.');
    }

    const comfy = await getComfyStatus();
    if (!comfy.available) {
      throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}. Please ensure ComfyUI is running.`);
    }
    if (!comfy.tripoReady) {
      throw new Error('ComfyUI is reachable but TripoSR nodes (TripoSRModelLoader / TripoSRSampler) are not loaded.');
    }

    // Server-Side Readiness Check: Verify all required dependencies exist
    const setup = await checkForgeDependencies();
    if (!setup.readyFor3D) {
      const missingNames = setup.items.filter((i) => i.required && !i.installed).map((i) => i.name).join(', ');
      throw new Error(`Neural 3D Engine is not ready (${setup.missingCount} required dependencies missing: ${missingNames}). Use Engine Setup to install them.`);
    }

    const assetId = `forge_${Date.now()}_${randomUUID().slice(0, 6)}`;
    const assetTitle = prompt.length > 35 ? prompt.slice(0, 32).trim() + '…' : (prompt || 'Reconstructed Mesh');
    let inputImageForTripo: string;
    let previewUrl: string | undefined;

    if (mode === 'text_to_3d') {
      if (!prompt) throw new Error('Prompt is required for Text-to-3D generation.');

      const sdCkpt = join(installation.comfyCoreDir, 'models', 'checkpoints', 'v1-5-pruned-emaonly.safetensors');
      if (!existsSync(sdCkpt)) {
        throw new Error('2D Concept Generator checkpoint (v1-5-pruned-emaonly.safetensors) is not installed. Use the 1-Click Engine Setup in the banner to download it.');
      }

      job.status = 'generating_concept';
      job.progress = 20;
      job.message = 'Generating isolated 2D concept art with Stable Diffusion...';

      const concept = await executeConceptGeneration({ prompt });

      // Save raw concept to Orchestra forge directory
      const rawConceptPath = join(FORGE_DIR, `${assetId}_raw.png`);
      writeFileSync(rawConceptPath, concept.buffer);

      // Preprocess image with rembg background removal & composite on 50% neutral gray canvas
      const processedConceptPath = join(FORGE_DIR, `${assetId}.png`);
      const prep = await preprocessImageForTripo(rawConceptPath, processedConceptPath);
      if (!prep.success) {
        throw new Error(`TripoSR concept image preprocessing failed: ${prep.error || 'Foreground segmentation failed'}`);
      }
      previewUrl = `/api/forge3d/assets/${assetId}.png`;

      // Copy processed image to ComfyUI input folder
      const comfyInputFilename = `${assetId}.png`;
      const comfyInputTarget = join(installation.inputDir, comfyInputFilename);
      copyFileSync(processedConceptPath, comfyInputTarget);
      inputImageForTripo = comfyInputFilename;

      // GPU Memory Staging: Free 2D diffusion weights from VRAM before loading TripoSR
      job.status = 'staging_gpu';
      job.progress = 45;
      job.message = 'Staging VRAM for 3D reconstruction (freeing 2D diffusion weights)...';
      await stageGpuForStep('reconstruction');
    } else {
      // Image to 3D mode
      if (!options.imageFilename) throw new Error('Image filename is required for Image-to-3D generation.');

      if (options.imageBuffer) {
        const rawUploadPath = join(FORGE_DIR, `${assetId}_raw.png`);
        writeFileSync(rawUploadPath, options.imageBuffer);

        const processedPath = join(FORGE_DIR, `${assetId}.png`);
        const prep = await preprocessImageForTripo(rawUploadPath, processedPath);
        if (!prep.success) {
          throw new Error(`TripoSR uploaded image preprocessing failed: ${prep.error || 'Foreground segmentation failed'}`);
        }
        previewUrl = `/api/forge3d/assets/${assetId}.png`;

        const comfyInputFilename = `${assetId}.png`;
        const dest = join(installation.inputDir, comfyInputFilename);
        copyFileSync(processedPath, dest);
        inputImageForTripo = comfyInputFilename;
      } else {
        inputImageForTripo = options.imageFilename;
      }

      job.status = 'staging_gpu';
      job.progress = 45;
      await stageGpuForStep('reconstruction');
    }

    job.status = 'reconstructing_mesh';
    job.progress = 60;
    job.message = 'Executing TripoSR neural 3D reconstruction on GPU...';

    // Neural mesh reconstruction
    const tripoResult = await executeTripoSRGeneration(inputImageForTripo, { geometryResolution: 256, threshold: 25.0 });
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
      mode,
      modelFormat: 'glb',
      modelPath: glbFilePath,
      modelUrl: `/api/forge3d/assets/${glbFileName}`,
      previewUrl,
      vertexCount: tripoResult.stats.vertexCount,
      triangleCount: tripoResult.stats.triangleCount,
      isWatertight: tripoResult.stats.isWatertight,
      surfaceArea: tripoResult.stats.surfaceArea,
      eulerNumber: tripoResult.stats.eulerNumber,
      boundingBox: tripoResult.stats.boundingBox,
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
