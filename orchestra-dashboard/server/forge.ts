import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import {
  executeConceptGeneration,
  executeSdxlTxt2Img,
  executeSdxlImg2Img,
  executeSdxlInpaint,
  executeSdxlIpAdapter,
  executeFluxTxt2Img,
  executeFluxImg2Img,
  executeLtxImg2Vid,
  executeWanImg2Vid,
  findComfyInstallation,
  getComfyStatus,
} from './comfy.js';
import { stageGpuForStep } from './gpu-manager.js';
import { getForgeEntity } from './forge-entities.js';
import {
  type AssetVersion,
  type ForgeAsset,
  type ForgeJob,
  type ForgeGenerateOptions,
  type ForgeRevisionOptions,
  type ForgeAnimateOptions,
  type VisualReview,
  type EditScope,
} from './forge-types.js';

export const FORGE_ASSETS_DIR = join(config.dataDir, 'forge', 'assets');
if (!existsSync(FORGE_ASSETS_DIR)) {
  mkdirSync(FORGE_ASSETS_DIR, { recursive: true });
}

const activeJobs = new Map<string, ForgeJob>();

export function listForgeAssets(): ForgeAsset[] {
  try {
    if (!existsSync(FORGE_ASSETS_DIR)) return [];
    const assetFolders = readdirSync(FORGE_ASSETS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const assets: ForgeAsset[] = [];
    for (const folder of assetFolders) {
      const metaPath = join(FORGE_ASSETS_DIR, folder, 'meta.json');
      if (existsSync(metaPath)) {
        try {
          const raw = readFileSync(metaPath, 'utf8');
          assets.push(JSON.parse(raw) as ForgeAsset);
        } catch {
          /* ignore corrupt item */
        }
      }
    }
    return assets.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch {
    return [];
  }
}

export function getForgeAsset(id: string): ForgeAsset | null {
  const metaPath = join(FORGE_ASSETS_DIR, id, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as ForgeAsset;
  } catch {
    return null;
  }
}

export function deleteForgeAsset(id: string): boolean {
  try {
    const assetDir = join(FORGE_ASSETS_DIR, id);
    if (existsSync(assetDir)) {
      rmSync(assetDir, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getForgeJob(id: string): ForgeJob | null {
  return activeJobs.get(id) || null;
}

export function revertAssetVersion(assetId: string, versionId: string): ForgeAsset {
  const asset = getForgeAsset(assetId);
  if (!asset) throw new Error(`Asset ${assetId} not found`);
  const targetVer = asset.versions.find((v) => v.versionId === versionId);
  if (!targetVer) throw new Error(`Version ${versionId} not found on asset ${assetId}`);

  asset.activeVersionId = versionId;
  asset.updatedAt = new Date().toISOString();
  saveAssetMeta(asset);
  return asset;
}

function saveAssetMeta(asset: ForgeAsset): void {
  const assetDir = join(FORGE_ASSETS_DIR, asset.id);
  if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, 'meta.json'), JSON.stringify(asset, null, 2));
}

// ─── Gemma 12B Vision Quality & Drift Reviewers ─────────────────────────────────

export async function requestCreationReview(
  prompt: string,
  imageBase64: string
): Promise<VisualReview> {
  await stageGpuForStep('vision_review');
  const lmStudioUrl = config.lmStudioBaseUrl.replace(/\/+$/, '');

  const systemInstruction = `You are an expert visual quality and composition reviewer.
Evaluate this newly generated 2D image against the prompt: "${prompt}".

Check for:
1. Prompt fidelity — Does it depict what was requested?
2. Anatomical correctness — Are hands, limbs, faces natural?
3. Composition & visual artifacts — Framing, lighting, noise, glitches.

Respond strictly in valid JSON:
{
  "verdict": "pass" | "needs_repair",
  "score": <0-100 integer>,
  "critique": "<2-3 sentence honest critique>",
  "failureType": "composition" | "anatomy" | "artifact" | "style_drift" | "none",
  "defectRegions": ["<specific defects if any>"],
  "suggestedAction": "<concrete guidance to fix flaw, or empty string if passed>"
}`;

  const res = await fetch(`${lmStudioUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.lmStudioModel || undefined,
      messages: [
        { role: 'system', content: systemInstruction },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Prompt: "${prompt}"\nReview the attached generated image:` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
          ],
        },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`LM Studio vision review failed (HTTP ${res.status}): ${errorText}`);
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
    score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 75,
    critique: parsed.critique || 'Visual creation review completed.',
    failureType: parsed.failureType || 'none',
    defectRegions: Array.isArray(parsed.defectRegions) ? parsed.defectRegions : [],
    suggestedAction: parsed.suggestedAction || '',
    reviewedAt: new Date().toISOString(),
  };
}

export async function requestRevisionReview(
  requestedChange: string,
  originalImageBase64: string,
  revisedImageBase64: string
): Promise<VisualReview> {
  await stageGpuForStep('vision_review');
  const lmStudioUrl = config.lmStudioBaseUrl.replace(/\/+$/, '');

  const systemInstruction = `You are an expert visual consistency and targeted revision inspector.
The user requested a SPECIFIC targeted change to an existing image.
Your job is to judge TWO independent criteria:
1. Requested Change Success: Did the requested change actually occur?
2. Unwanted Drift Prevention: Did ANYTHING that was supposed to remain unchanged (face, identity, camera framing, pose, background, art style) accidentally drift or distort?

Requested Change: "${requestedChange}"

Respond strictly in valid JSON:
{
  "verdict": "pass" | "needs_repair",
  "score": <0-100 composite quality score>,
  "revisionMetrics": {
    "requestedChangeSuccess": <0-100>,
    "identityPreservation": <0-100>,
    "compositionPreservation": <0-100>,
    "backgroundPreservation": <0-100>,
    "stylePreservation": <0-100>
  },
  "critique": "<2-3 sentence explanation of what succeeded and any unwanted drift>",
  "failureType": "identity_drift" | "composition" | "style_drift" | "artifact" | "none",
  "suggestedAction": "<concrete guidance if repair is needed>"
}`;

  const res = await fetch(`${lmStudioUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.lmStudioModel || undefined,
      messages: [
        { role: 'system', content: systemInstruction },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Requested Change: "${requestedChange}"\nImage 1: ORIGINAL (Before)\nImage 2: REVISED (After)` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${originalImageBase64}` } },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${revisedImageBase64}` } },
          ],
        },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`LM Studio revision review failed (HTTP ${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as any;
  const rawContent = data.choices?.[0]?.message?.content || '';
  const cleanJson = rawContent.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleanJson);
  } catch {
    throw new Error(`Failed to parse Gemma revision critique JSON: ${rawContent}`);
  }

  return {
    verdict: parsed.verdict === 'needs_repair' ? 'needs_repair' : 'pass',
    score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 75,
    revisionMetrics: parsed.revisionMetrics || {
      requestedChangeSuccess: 80,
      identityPreservation: 80,
      compositionPreservation: 80,
      backgroundPreservation: 80,
      stylePreservation: 80,
    },
    critique: parsed.critique || 'Visual revision review completed.',
    failureType: parsed.failureType || 'none',
    suggestedAction: parsed.suggestedAction || '',
    reviewedAt: new Date().toISOString(),
  };
}

export async function requestVideoReview(
  prompt: string,
  keyframesBase64: string[]
): Promise<VisualReview> {
  await stageGpuForStep('vision_review');
  const lmStudioUrl = config.lmStudioBaseUrl.replace(/\/+$/, '');

  const systemInstruction = `You are an expert video continuity and temporal quality reviewer.
Evaluate this animated video sequence (sampled across start, middle, and end keyframes) against the prompt: "${prompt}".

Check for:
1. Temporal consistency — Is character identity, background, and lighting consistent across frames?
2. Motion naturalness — Are movements smooth without warping, limb duplication, or tearing?
3. Prompt fidelity — Does the animation fulfill the cinematic intent?

Respond strictly in valid JSON:
{
  "verdict": "pass" | "needs_repair",
  "score": <0-100 integer>,
  "revisionMetrics": {
    "requestedChangeSuccess": <0-100>,
    "identityPreservation": <0-100>,
    "compositionPreservation": <0-100>,
    "backgroundPreservation": <0-100>,
    "stylePreservation": <0-100>,
    "temporalConsistency": <0-100>
  },
  "critique": "<2-3 sentence honest evaluation of motion and temporal continuity>",
  "failureType": "temporal" | "composition" | "artifact" | "identity_drift" | "none",
  "suggestedAction": "<concrete guidance if repair is needed, or empty string if passed>"
}`;

  const imageMessages = keyframesBase64.map((b64) => ({
    type: 'image_url' as const,
    image_url: { url: `data:image/png;base64,${b64}` },
  }));

  const res = await fetch(`${lmStudioUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.lmStudioModel || undefined,
      messages: [
        { role: 'system', content: systemInstruction },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Prompt: "${prompt}"\nReview attached keyframes from the animated sequence:` },
            ...imageMessages,
          ],
        },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`LM Studio video review failed (HTTP ${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as any;
  const rawContent = data.choices?.[0]?.message?.content || '';
  const cleanJson = rawContent.replace(/```json\s*/gi, '').replace(/```\s*$/gi, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleanJson);
  } catch {
    throw new Error(`Failed to parse Gemma video critique JSON: ${rawContent}`);
  }

  return {
    verdict: parsed.verdict === 'needs_repair' ? 'needs_repair' : 'pass',
    score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 75,
    revisionMetrics: parsed.revisionMetrics || {
      requestedChangeSuccess: 80,
      identityPreservation: 80,
      compositionPreservation: 80,
      backgroundPreservation: 80,
      stylePreservation: 80,
      temporalConsistency: 80,
    },
    critique: parsed.critique || 'Video temporal review completed.',
    failureType: parsed.failureType || 'none',
    suggestedAction: parsed.suggestedAction || '',
    reviewedAt: new Date().toISOString(),
  };
}

// ─── Execution Engines: Generation, Revision, and Repair ─────────────────────────

export function resolveActiveImageCheckpoint(requested?: string): { ckptName: string; isSdxl: boolean } {
  const installation = findComfyInstallation();
  if (!installation) return { ckptName: 'v1-5-pruned-emaonly.safetensors', isSdxl: false };
  const ckptDir = join(installation.comfyCoreDir, 'models', 'checkpoints');

  if (requested && existsSync(join(ckptDir, requested))) {
    const isSdxl = !/v1-5|sd15|model\.ckpt/i.test(requested);
    return { ckptName: requested, isSdxl };
  }

  const preferredSdxl = [
    'RealVisXL_V5.0.safetensors',
    'juggernautXL_v9.safetensors',
    'CyberRealisticXL_v2.0.safetensors',
    'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
  ];

  for (const name of preferredSdxl) {
    if (existsSync(join(ckptDir, name))) {
      return { ckptName: name, isSdxl: true };
    }
  }

  if (existsSync(ckptDir)) {
    const files = readdirSync(ckptDir).filter((f) => f.endsWith('.safetensors') && !/model\.ckpt/i.test(f));
    const nonSd15 = files.find((f) => !/v1-5|sd15/i.test(f));
    if (nonSd15) return { ckptName: nonSd15, isSdxl: true };
    if (files.length > 0) return { ckptName: files[0], isSdxl: false };
  }

  return { ckptName: 'v1-5-pruned-emaonly.safetensors', isSdxl: false };
}

export async function runForgeGeneration(options: ForgeGenerateOptions): Promise<ForgeAsset> {
  const installation = findComfyInstallation();
  if (!installation) throw new Error('ComfyUI installation directory not found.');

  const comfy = await getComfyStatus();
  if (!comfy.available) throw new Error(`ComfyUI is not reachable at ${comfy.endpoint}.`);

  const jobId = randomUUID();
  const job: ForgeJob = {
    id: jobId,
    prompt: options.prompt,
    type: options.type || 'image',
    status: 'queued',
    currentIteration: 1,
    maxIterations: 2,
    progress: 10,
    message: 'Initializing image generation...',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  activeJobs.set(jobId, job);

  try {
    const assetId = `forge_${Date.now()}_${randomUUID().slice(0, 6)}`;
    const assetDir = join(FORGE_ASSETS_DIR, assetId);
    mkdirSync(assetDir, { recursive: true });

    const boundEntity = options.entityId ? getForgeEntity(options.entityId) : null;
    let promptWithEntity = options.prompt;
    if (boundEntity?.triggerWord && !promptWithEntity.includes(boundEntity.triggerWord)) {
      promptWithEntity = `${boundEntity.triggerWord}, ${promptWithEntity}`;
    }

    const seed = options.seed ?? Math.floor(Math.random() * 1000000000000);
    const steps = options.steps || 25;
    const cfg = options.cfg || 7.0;

    let resultBuffer: Buffer;
    const { ckptName, isSdxl } = resolveActiveImageCheckpoint(options.checkpoint);
    const isFlux = /flux/i.test(ckptName);
    let workflowType = isFlux ? 'flux-txt2img' : isSdxl ? 'sdxl-txt2img' : 'concept-gen';

    if (boundEntity && boundEntity.referenceImages.length > 0) {
      job.status = 'staging_gpu';
      job.progress = 25;
      job.message = `Staging GPU for IP-Adapter character conditioning (${boundEntity.name})...`;
      await stageGpuForStep('ipadapter');

      job.status = 'generating';
      job.progress = 50;
      job.message = `Synthesizing scene with character identity lock (${boundEntity.name})...`;

      const primaryRef = boundEntity.referenceImages[0];
      const refFilename = `${assetId}_entity_ref.png`;
      copyFileSync(primaryRef.imagePath, join(installation.inputDir, refFilename));

      const gen = await executeSdxlIpAdapter({
        referenceImage: refFilename,
        ipAdapterWeight: options.entityWeight ?? boundEntity.ipAdapterWeight ?? 0.8,
        prompt: promptWithEntity,
        negativePrompt: options.negativePrompt,
        ckptName,
        width: options.width || 1024,
        height: options.height || 1024,
        steps,
        cfg,
        seed,
      });
      resultBuffer = gen.buffer;
      workflowType = 'sdxl-ipadapter';
    } else if (isFlux) {
      const clipDir = join(installation.comfyCoreDir, 'models', 'clip');
      const vaeDir = join(installation.comfyCoreDir, 'models', 'vae');
      const textEncDir = join(installation.comfyCoreDir, 'models', 'text_encoders');
      const hasT5 = existsSync(join(clipDir, 't5xxl_fp8_e4m3fn.safetensors')) || existsSync(join(textEncDir, 't5xxl_fp8_e4m3fn.safetensors'));
      const hasClipL = existsSync(join(clipDir, 'clip_l.safetensors')) || existsSync(join(textEncDir, 'clip_l.safetensors'));
      const hasVae = existsSync(join(vaeDir, 'ae.safetensors'));

      if (!hasT5 || !hasClipL || !hasVae) {
        const missing = [
          !hasT5 && 'T5-XXL (t5xxl_fp8_e4m3fn.safetensors)',
          !hasClipL && 'CLIP-L (clip_l.safetensors)',
          !hasVae && 'VAE (ae.safetensors)',
        ].filter(Boolean);
        throw new Error(
          `FLUX.1 requires companion text encoders & VAE before generating. Missing: ${missing.join(', ')}. Please click 'Model Library & VRAM' in Forge Studio to 1-click install them, or select RealVisXL / Juggernaut for instant standalone generation.`
        );
      }

      job.status = 'staging_gpu';
      job.progress = 25;
      job.message = `Staging GPU for FLUX generation (${ckptName})...`;
      await stageGpuForStep('txt2img');

      job.status = 'generating';
      job.progress = 50;
      job.message = 'Executing 12B Flow Transformer synthesis...';

      const gen = await executeFluxTxt2Img({
        prompt: promptWithEntity,
        negativePrompt: options.negativePrompt,
        unetName: ckptName,
        clip1: 't5xxl_fp8_e4m3fn.safetensors',
        clip2: 'clip_l.safetensors',
        vaeName: 'ae.safetensors',
        guidance: /schnell/i.test(ckptName) ? 1.0 : 3.5,
        width: options.width || 1024,
        height: options.height || 1024,
        steps: options.steps || (/schnell/i.test(ckptName) ? 4 : 20),
        samplerName: 'euler',
        scheduler: 'simple',
        seed,
      });
      resultBuffer = gen.buffer;
      workflowType = 'flux-txt2img';
    } else if (isSdxl) {
      job.status = 'staging_gpu';
      job.progress = 25;
      job.message = `Staging GPU for SDXL generation (${ckptName})...`;
      await stageGpuForStep('txt2img');

      job.status = 'generating';
      job.progress = 50;
      job.message = 'Executing neural image synthesis...';

      const gen = await executeSdxlTxt2Img({
        prompt: promptWithEntity,
        negativePrompt: options.negativePrompt,
        ckptName,
        width: options.width || 1024,
        height: options.height || 1024,
        steps,
        cfg,
        seed,
      });
      resultBuffer = gen.buffer;
      workflowType = 'sdxl-txt2img';
    } else {
      job.status = 'staging_gpu';
      job.progress = 25;
      job.message = 'Staging GPU for concept generation...';
      await stageGpuForStep('txt2img');

      job.status = 'generating';
      job.progress = 50;
      job.message = 'Executing neural image synthesis...';

      const gen = await executeConceptGeneration({
        prompt: promptWithEntity,
        negativePrompt: options.negativePrompt,
        width: options.width || 512,
        height: options.height || 512,
        steps,
        cfg,
        seed,
      });
      resultBuffer = gen.buffer;
      workflowType = 'concept-gen';
    }

    const v1Path = join(assetDir, 'v1.png');
    writeFileSync(v1Path, resultBuffer);

    const v1: AssetVersion = {
      versionId: 'v1',
      parentVersionId: null,
      operationType: 'create',
      changeDescription: boundEntity ? `Generated with ${boundEntity.name}` : 'Initial generation',
      params: {
        workflow: workflowType,
        checkpoint: ckptName,
        seed,
        steps,
        cfg,
        denoise: 1.0,
        sampler: 'euler',
        scheduler: 'normal',
        width: options.width || (isSdxl ? 1024 : 512),
        height: options.height || (isSdxl ? 1024 : 512),
        prompt: promptWithEntity,
        negativePrompt: options.negativePrompt,
        entityId: options.entityId,
      },
      outputPath: v1Path,
      outputUrl: `/api/forge/assets/${assetId}/v1.png`,
      createdAt: new Date().toISOString(),
    };

    const asset: ForgeAsset = {
      id: assetId,
      type: options.type || 'image',
      title: options.prompt.length > 40 ? options.prompt.slice(0, 37) + '…' : options.prompt,
      originalPrompt: options.prompt,
      activeVersionId: 'v1',
      versions: [v1],
      entityRefs: options.entityId ? [options.entityId] : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveAssetMeta(asset);
    job.status = 'completed';
    job.progress = 100;
    job.message = 'Generation completed!';
    job.asset = asset;
    return asset;
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.message = `Generation failed: ${job.error}`;
    throw error;
  }
}

export async function runForgeRevision(options: ForgeRevisionOptions): Promise<ForgeAsset> {
  const asset = getForgeAsset(options.assetId);
  if (!asset) throw new Error(`Asset ${options.assetId} not found.`);

  const targetVerId = options.targetVersionId || asset.activeVersionId;
  const parentVer = asset.versions.find((v) => v.versionId === targetVerId);
  if (!parentVer) throw new Error(`Target version ${targetVerId} not found.`);

  const installation = findComfyInstallation();
  if (!installation) throw new Error('ComfyUI installation directory not found.');

  const nextVerIndex = asset.versions.length + 1;
  const nextVerId = `v${nextVerIndex}`;
  const assetDir = join(FORGE_ASSETS_DIR, asset.id);

  const scope: EditScope = options.scope || (options.maskBase64 ? 'localized' : 'structural');
  const denoise = typeof options.denoise === 'number' ? options.denoise : (scope === 'localized' ? 0.85 : 0.70);

  let resultBuffer: Buffer;
  const nextVerPath = join(assetDir, `${nextVerId}.png`);

  if (scope === 'localized' && options.maskBase64) {
    // Localized inpainting revision
    await stageGpuForStep('inpaint');
    const maskBuffer = Buffer.from(options.maskBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const maskFilename = `${asset.id}_${nextVerId}_mask.png`;
    const sourceFilename = `${asset.id}_${nextVerId}_src.png`;

    writeFileSync(join(assetDir, `${nextVerId}_mask.png`), maskBuffer);
    copyFileSync(parentVer.outputPath, join(installation.inputDir, sourceFilename));
    writeFileSync(join(installation.inputDir, maskFilename), maskBuffer);

    const activeCkpt = parentVer.params.checkpoint || resolveActiveImageCheckpoint().ckptName;
    const isFlux = /flux/i.test(activeCkpt);

    if (isFlux) {
      // FLUX inpainting: use FLUX img2img with high denoise as fallback
      // (FLUX checkpoints don't bundle VAE, so SDXL inpaint graph fails)
      const fluxResult = await executeFluxImg2Img({
        sourceImage: sourceFilename,
        prompt: `${options.revisionPrompt}, ${parentVer.params.prompt}`,
        negativePrompt: parentVer.params.negativePrompt,
        unetName: activeCkpt,
        clip1: 't5xxl_fp8_e4m3fn.safetensors',
        clip2: 'clip_l.safetensors',
        vaeName: 'ae.safetensors',
        guidance: /schnell/i.test(activeCkpt) ? 1.0 : 3.5,
        steps: /schnell/i.test(activeCkpt) ? 4 : 20,
        samplerName: 'euler',
        scheduler: 'simple',
        seed: parentVer.params.seed,
        denoise,
      });
      resultBuffer = fluxResult.buffer;
    } else {
      const inpaint = await executeSdxlInpaint({
        sourceImage: sourceFilename,
        maskImage: maskFilename,
        prompt: `${options.revisionPrompt}, ${parentVer.params.prompt}`,
        negativePrompt: parentVer.params.negativePrompt,
        ckptName: activeCkpt,
        seed: parentVer.params.seed,
        denoise,
      });
      resultBuffer = inpaint.buffer;
    }
  } else {
    // Structural img2img revision
    await stageGpuForStep('img2img');
    const sourceFilename = `${asset.id}_${nextVerId}_src.png`;
    copyFileSync(parentVer.outputPath, join(installation.inputDir, sourceFilename));

    const activeCkpt = parentVer.params.checkpoint || resolveActiveImageCheckpoint().ckptName;
    const isFlux = /flux/i.test(activeCkpt);

    if (isFlux) {
      // FLUX img2img: separate DualCLIPLoader + VAELoader
      // (FLUX checkpoints don't bundle VAE, so SDXL img2img graph fails)
      const fluxResult = await executeFluxImg2Img({
        sourceImage: sourceFilename,
        prompt: `${options.revisionPrompt}, ${parentVer.params.prompt}`,
        negativePrompt: parentVer.params.negativePrompt,
        unetName: activeCkpt,
        clip1: 't5xxl_fp8_e4m3fn.safetensors',
        clip2: 'clip_l.safetensors',
        vaeName: 'ae.safetensors',
        guidance: /schnell/i.test(activeCkpt) ? 1.0 : 3.5,
        steps: /schnell/i.test(activeCkpt) ? 4 : 20,
        samplerName: 'euler',
        scheduler: 'simple',
        seed: parentVer.params.seed,
        denoise,
      });
      resultBuffer = fluxResult.buffer;
    } else {
      const img2img = await executeSdxlImg2Img({
        sourceImage: sourceFilename,
        prompt: `${options.revisionPrompt}, ${parentVer.params.prompt}`,
        negativePrompt: parentVer.params.negativePrompt,
        ckptName: activeCkpt,
        seed: parentVer.params.seed,
        denoise,
      });
      resultBuffer = img2img.buffer;
    }
  }

  writeFileSync(nextVerPath, resultBuffer);

  const newVersion: AssetVersion = {
    versionId: nextVerId,
    parentVersionId: parentVer.versionId,
    operationType: 'user_revision',
    editScope: scope,
    changeDescription: options.revisionPrompt,
    params: {
      ...parentVer.params,
      prompt: `${options.revisionPrompt}, ${parentVer.params.prompt}`,
      denoise,
      sourceImagePath: parentVer.outputPath,
    },
    outputPath: nextVerPath,
    outputUrl: `/api/forge/assets/${asset.id}/${nextVerId}.png`,
    createdAt: new Date().toISOString(),
  };

  asset.versions.push(newVersion);
  asset.activeVersionId = nextVerId;
  asset.updatedAt = new Date().toISOString();
  saveAssetMeta(asset);

  return asset;
}

export async function runForgeAnimateVersion(options: ForgeAnimateOptions): Promise<ForgeAsset> {
  const asset = getForgeAsset(options.assetId);
  if (!asset) throw new Error(`Asset ${options.assetId} not found.`);

  const sourceVerId = options.sourceVersionId || asset.activeVersionId;
  const sourceVer = asset.versions.find((v) => v.versionId === sourceVerId);
  if (!sourceVer) throw new Error(`Source version ${sourceVerId} not found.`);

  const installation = findComfyInstallation();
  if (!installation) throw new Error('ComfyUI installation directory not found.');

  const nextVerIndex = asset.versions.length + 1;
  const nextVerId = `v${nextVerIndex}`;
  const assetDir = join(FORGE_ASSETS_DIR, asset.id);

  await stageGpuForStep('video_gen');

  const sourceFilename = `${asset.id}_${nextVerId}_source.png`;
  copyFileSync(sourceVer.outputPath, join(installation.inputDir, sourceFilename));

  const model = options.videoModel || 'ltx-video';
  const prompt = options.animationPrompt || 'cinematic camera movement, smooth motion, high visual quality';
  const fps = options.fps || 24;

  let resultBuffer: Buffer;
  const ext = 'webp';

  if (model === 'wan2.1-1.3b') {
    const video = await executeWanImg2Vid({
      sourceImage: sourceFilename,
      prompt,
      negativePrompt: options.negativePrompt,
      fps: 16,
      steps: options.steps || 25,
      cfg: options.cfg || 6.0,
      seed: options.seed ?? sourceVer.params.seed,
    });
    resultBuffer = video.buffer;
  } else {
    // Default: LTX-Video 2B distilled
    const video = await executeLtxImg2Vid({
      sourceImage: sourceFilename,
      prompt,
      negativePrompt: options.negativePrompt,
      fps,
      steps: options.steps || 20,
      cfg: options.cfg || 3.0,
      seed: options.seed ?? sourceVer.params.seed,
      denoise: options.denoise ?? 1.0,
    });
    resultBuffer = video.buffer;
  }

  const nextVerPath = join(assetDir, `${nextVerId}.${ext}`);
  writeFileSync(nextVerPath, resultBuffer);

  const newVersion: AssetVersion = {
    versionId: nextVerId,
    parentVersionId: sourceVer.versionId,
    operationType: 'animate',
    changeDescription: `Animation: ${prompt}`,
    params: {
      ...sourceVer.params,
      workflow: model === 'wan2.1-1.3b' ? 'wan21-img2vid' : 'ltx-img2vid',
      checkpoint: model === 'wan2.1-1.3b' ? 'wan2.1_i2v_480p_14B_bf16.safetensors' : 'ltx-video-2b-v0.9.5.safetensors',
      prompt,
      fps,
      videoModel: model,
      sourceImagePath: sourceVer.outputPath,
    },
    outputPath: nextVerPath,
    outputUrl: `/api/forge/assets/${asset.id}/${nextVerId}.${ext}`,
    videoUrl: `/api/forge/assets/${asset.id}/${nextVerId}.${ext}`,
    fps,
    sourceImageVersionId: sourceVer.versionId,
    createdAt: new Date().toISOString(),
  };

  asset.versions.push(newVersion);
  asset.activeVersionId = nextVerId;
  asset.updatedAt = new Date().toISOString();
  saveAssetMeta(asset);

  return asset;
}

