import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type {
  StoryboardSequence,
  StoryboardShot,
  ShotType,
  CameraMovement,
} from './forge-types.js';
import { getForgeEntity } from './forge-entities.js';
import {
  executeSdxlTxt2Img,
  executeSdxlIpAdapter,
  executeLtxImg2Vid,
  executeWanImg2Vid,
  findComfyInstallation,
} from './comfy.js';
import { stageGpuForStep } from './gpu-manager.js';

export const FORGE_STORYBOARDS_DIR = join(config.dataDir, 'forge', 'storyboards');
if (!existsSync(FORGE_STORYBOARDS_DIR)) {
  mkdirSync(FORGE_STORYBOARDS_DIR, { recursive: true });
}

export function listStoryboards(): StoryboardSequence[] {
  try {
    if (!existsSync(FORGE_STORYBOARDS_DIR)) return [];
    const folders = readdirSync(FORGE_STORYBOARDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const list: StoryboardSequence[] = [];
    for (const folder of folders) {
      const metaPath = join(FORGE_STORYBOARDS_DIR, folder, 'meta.json');
      if (existsSync(metaPath)) {
        try {
          list.push(JSON.parse(readFileSync(metaPath, 'utf8')) as StoryboardSequence);
        } catch {
          /* ignore */
        }
      }
    }
    return list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    return [];
  }
}

export function getStoryboard(id: string): StoryboardSequence | null {
  const metaPath = join(FORGE_STORYBOARDS_DIR, id, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as StoryboardSequence;
  } catch {
    return null;
  }
}

export function saveStoryboardMeta(seq: StoryboardSequence): void {
  const dir = join(FORGE_STORYBOARDS_DIR, seq.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(seq, null, 2));
}

export function createStoryboard(data: {
  title: string;
  description?: string;
  defaultFps?: number;
  videoModel?: 'ltx-video' | 'wan2.1-1.3b' | 'wan2.1-14b';
}): StoryboardSequence {
  const id = `sb_${Date.now()}_${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();

  const seq: StoryboardSequence = {
    id,
    title: data.title.trim(),
    description: data.description?.trim() || '',
    shots: [],
    defaultFps: data.defaultFps || 24,
    videoModel: data.videoModel || 'ltx-video',
    createdAt: now,
    updatedAt: now,
  };

  saveStoryboardMeta(seq);
  return seq;
}

export function updateStoryboard(id: string, patch: Partial<StoryboardSequence>): StoryboardSequence {
  const seq = getStoryboard(id);
  if (!seq) throw new Error(`Storyboard ${id} not found.`);

  const updated: StoryboardSequence = {
    ...seq,
    ...patch,
    id: seq.id,
    updatedAt: new Date().toISOString(),
  };

  saveStoryboardMeta(updated);
  return updated;
}

export function deleteStoryboard(id: string): boolean {
  try {
    const dir = join(FORGE_STORYBOARDS_DIR, id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function addShotToStoryboard(
  storyboardId: string,
  shotData: {
    title?: string;
    shotType?: ShotType;
    cameraMovement?: CameraMovement;
    prompt: string;
    negativePrompt?: string;
    durationSeconds?: number;
    fps?: number;
    entityRefs?: string[];
  }
): StoryboardShot {
  const seq = getStoryboard(storyboardId);
  if (!seq) throw new Error(`Storyboard ${storyboardId} not found.`);

  const shotId = `shot_${seq.shots.length + 1}_${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();

  const shot: StoryboardShot = {
    id: shotId,
    orderIndex: seq.shots.length + 1,
    title: shotData.title?.trim() || `Shot ${seq.shots.length + 1}`,
    shotType: shotData.shotType || 'medium',
    cameraMovement: shotData.cameraMovement || 'pan_right',
    prompt: shotData.prompt.trim(),
    negativePrompt: shotData.negativePrompt?.trim() || undefined,
    durationSeconds: shotData.durationSeconds || 3,
    fps: shotData.fps || seq.defaultFps || 24,
    entityRefs: shotData.entityRefs || [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  seq.shots.push(shot);
  seq.updatedAt = now;
  saveStoryboardMeta(seq);

  return shot;
}

export function updateShot(
  storyboardId: string,
  shotId: string,
  patch: Partial<StoryboardShot>
): StoryboardShot {
  const seq = getStoryboard(storyboardId);
  if (!seq) throw new Error(`Storyboard ${storyboardId} not found.`);

  const idx = seq.shots.findIndex((s) => s.id === shotId);
  if (idx === -1) throw new Error(`Shot ${shotId} not found in storyboard ${storyboardId}.`);

  const updatedShot: StoryboardShot = {
    ...seq.shots[idx],
    ...patch,
    id: seq.shots[idx].id,
    updatedAt: new Date().toISOString(),
  };

  seq.shots[idx] = updatedShot;
  seq.updatedAt = new Date().toISOString();
  saveStoryboardMeta(seq);

  return updatedShot;
}

export function deleteShot(storyboardId: string, shotId: string): boolean {
  const seq = getStoryboard(storyboardId);
  if (!seq) return false;

  const initialLength = seq.shots.length;
  seq.shots = seq.shots.filter((s) => s.id !== shotId);
  if (seq.shots.length === initialLength) return false;

  // Re-index remaining shots
  seq.shots.forEach((s, i) => {
    s.orderIndex = i + 1;
  });
  seq.updatedAt = new Date().toISOString();
  saveStoryboardMeta(seq);
  return true;
}

export function reorderShots(storyboardId: string, orderedShotIds: string[]): StoryboardSequence {
  const seq = getStoryboard(storyboardId);
  if (!seq) throw new Error(`Storyboard ${storyboardId} not found.`);

  const map = new Map(seq.shots.map((s) => [s.id, s]));
  const reordered: StoryboardShot[] = [];

  orderedShotIds.forEach((id, idx) => {
    const s = map.get(id);
    if (s) {
      s.orderIndex = idx + 1;
      reordered.push(s);
      map.delete(id);
    }
  });

  // Append any unmentioned shots
  map.forEach((s) => {
    s.orderIndex = reordered.length + 1;
    reordered.push(s);
  });

  seq.shots = reordered;
  seq.updatedAt = new Date().toISOString();
  saveStoryboardMeta(seq);
  return seq;
}

// ─── Visual Continuity Sequence Rendering Engine ────────────────────────────────

export async function renderStoryboardShot(
  storyboardId: string,
  shotId: string
): Promise<StoryboardShot> {
  const seq = getStoryboard(storyboardId);
  if (!seq) throw new Error(`Storyboard ${storyboardId} not found.`);

  const shot = seq.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`Shot ${shotId} not found.`);

  const installation = findComfyInstallation();
  if (!installation) throw new Error('ComfyUI installation directory not located.');

  const shotDir = join(FORGE_STORYBOARDS_DIR, storyboardId, 'shots', shot.id);
  if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });

  shot.status = 'generating_still';
  saveStoryboardMeta(seq);

  try {
    // 1. Resolve visual continuity and entity conditioning
    let boundEntity = shot.entityRefs?.[0] ? getForgeEntity(shot.entityRefs[0]) : null;
    let fullPrompt = `${shot.shotType} shot, ${shot.prompt}`;
    if (boundEntity?.triggerWord && !fullPrompt.includes(boundEntity.triggerWord)) {
      fullPrompt = `${boundEntity.triggerWord}, ${fullPrompt}`;
    }

    let stillBuffer: Buffer;

    if (boundEntity && boundEntity.referenceImages.length > 0) {
      await stageGpuForStep('ipadapter');
      const primaryRef = boundEntity.referenceImages[0];
      const refFilename = `${storyboardId}_${shot.id}_ref.png`;
      copyFileSync(primaryRef.imagePath, join(installation.inputDir, refFilename));

      const gen = await executeSdxlIpAdapter({
        referenceImage: refFilename,
        ipAdapterWeight: boundEntity.ipAdapterWeight || 0.8,
        prompt: fullPrompt,
        negativePrompt: shot.negativePrompt,
        ckptName: 'juggernautXL_v9.safetensors',
        width: 1024,
        height: 1024,
        steps: 25,
        cfg: 7.0,
      });
      stillBuffer = gen.buffer;
    } else {
      await stageGpuForStep('txt2img');
      const gen = await executeSdxlTxt2Img({
        prompt: fullPrompt,
        negativePrompt: shot.negativePrompt,
        ckptName: 'juggernautXL_v9.safetensors',
        width: 1024,
        height: 1024,
        steps: 25,
        cfg: 7.0,
      });
      stillBuffer = gen.buffer;
    }

    const stillPath = join(shotDir, 'still.png');
    writeFileSync(stillPath, stillBuffer);
    shot.sourceStillPath = stillPath;
    shot.sourceStillUrl = `/api/forge/storyboards/${storyboardId}/shots/${shot.id}/still.png`;

    // 2. Animate Still into Video with Camera Movement
    shot.status = 'generating_video';
    saveStoryboardMeta(seq);

    await stageGpuForStep('video_gen');
    const sourceFilename = `${storyboardId}_${shot.id}_source.png`;
    copyFileSync(stillPath, join(installation.inputDir, sourceFilename));

    const cameraDirection = shot.cameraMovement.replace('_', ' ');
    const animPrompt = `cinematic camera ${cameraDirection}, smooth motion, high visual quality, ${shot.prompt}`;

    let videoBuffer: Buffer;
    const ext = 'webp';

    if (seq.videoModel === 'wan2.1-1.3b') {
      const vid = await executeWanImg2Vid({
        sourceImage: sourceFilename,
        prompt: animPrompt,
        fps: 16,
        steps: 25,
      });
      videoBuffer = vid.buffer;
    } else {
      const vid = await executeLtxImg2Vid({
        sourceImage: sourceFilename,
        prompt: animPrompt,
        fps: shot.fps || 24,
        steps: 20,
        cfg: 3.0,
      });
      videoBuffer = vid.buffer;
    }

    const videoPath = join(shotDir, `video.${ext}`);
    writeFileSync(videoPath, videoBuffer);
    shot.videoPath = videoPath;
    shot.videoUrl = `/api/forge/storyboards/${storyboardId}/shots/${shot.id}/video.${ext}`;

    // 3. Mark Handoff Frame for subsequent shots
    shot.handoffFramePath = stillPath;
    shot.handoffFrameUrl = shot.sourceStillUrl;
    shot.status = 'completed';
    shot.updatedAt = new Date().toISOString();
    saveStoryboardMeta(seq);

    return shot;
  } catch (err) {
    shot.status = 'failed';
    shot.error = err instanceof Error ? err.message : String(err);
    shot.updatedAt = new Date().toISOString();
    saveStoryboardMeta(seq);
    throw err;
  }
}

export async function renderFullStoryboardSequence(
  storyboardId: string
): Promise<StoryboardSequence> {
  const seq = getStoryboard(storyboardId);
  if (!seq) throw new Error(`Storyboard ${storyboardId} not found.`);

  // Render each shot sequentially in orderIndex
  for (const shot of seq.shots) {
    await renderStoryboardShot(storyboardId, shot.id);
  }

  return getStoryboard(storyboardId) || seq;
}
