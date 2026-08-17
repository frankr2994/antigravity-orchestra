export type AssetType = 'image' | 'video';

export type OperationType =
  | 'create'
  | 'auto_repair'
  | 'user_revision'
  | 'animate'
  | 'upscale'
  | 'variant';

export type EditScope =
  | 'localized'
  | 'regional'
  | 'structural'
  | 'full';

export type EntityCategory =
  | 'character'
  | 'vehicle'
  | 'prop'
  | 'environment';

export interface ReferenceImage {
  id: string;
  label?: string;
  imagePath: string;
  imageUrl: string;
  uploadedAt: string;
}

export interface ForgeEntity {
  id: string;
  name: string;
  category: EntityCategory;
  description: string;
  triggerWord?: string;
  referenceImages: ReferenceImage[];
  loraPath?: string;
  loraWeight?: number;
  ipAdapterWeight?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ControlNetConfig {
  model: string;
  type: 'depth' | 'canny' | 'openpose' | 'softedge' | 'lineart';
  strength: number;
  startPercent?: number;
  endPercent?: number;
  preprocessor?: string;
  inputImagePath?: string;
}

export interface IPAdapterConfig {
  model: string;
  clipVisionModel: string;
  weight: number;
  referenceImagePath: string;
  faceOnly?: boolean;
}

export interface GenerationParams {
  workflow: string;
  checkpoint: string;
  seed: number;
  steps: number;
  cfg: number;
  denoise: number;
  sampler: string;
  scheduler: string;
  width: number;
  height: number;
  prompt: string;
  negativePrompt?: string;
  controlnets?: ControlNetConfig[];
  ipAdapters?: IPAdapterConfig[];
  maskPath?: string;
  sourceImagePath?: string;
  referenceImages?: string[];
  entityId?: string;
  entityWeight?: number;
  fps?: number;
  durationSeconds?: number;
  frameCount?: number;
  videoModel?: 'ltx-video' | 'wan2.1-1.3b' | 'wan2.1-14b';
}

export interface RevisionMetrics {
  requestedChangeSuccess: number;
  identityPreservation: number;
  compositionPreservation: number;
  backgroundPreservation: number;
  stylePreservation: number;
  temporalConsistency?: number;
}

export interface VisualReview {
  verdict: 'pass' | 'needs_repair';
  score: number;
  critique: string;
  failureType: 'composition' | 'anatomy' | 'artifact' | 'identity_drift' | 'style_drift' | 'temporal' | 'none';
  revisionMetrics?: RevisionMetrics;
  defectRegions?: string[];
  suggestedAction?: string;
  reviewedAt: string;
}

export interface AssetVersion {
  versionId: string;
  parentVersionId: string | null;
  operationType: OperationType;
  editScope?: EditScope;
  changeDescription: string;
  params: GenerationParams;
  outputPath: string;
  outputUrl: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  durationSeconds?: number;
  fps?: number;
  frameCount?: number;
  sourceImageVersionId?: string;
  review?: VisualReview;
  createdAt: string;
}

export interface ForgeAsset {
  id: string;
  type: AssetType;
  title: string;
  originalPrompt: string;
  activeVersionId: string;
  versions: AssetVersion[];
  entityRefs?: string[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ForgeJob {
  id: string;
  prompt: string;
  type: AssetType;
  status: 'queued' | 'staging_gpu' | 'generating' | 'evaluating_vision' | 'completed' | 'failed';
  currentIteration: number;
  maxIterations: number;
  progress: number;
  message: string;
  asset?: ForgeAsset;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ForgeGenerateOptions {
  prompt: string;
  negativePrompt?: string;
  style?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  checkpoint?: string;
  type?: AssetType;
  entityId?: string;
  entityWeight?: number;
  videoModel?: 'ltx-video' | 'wan2.1-1.3b' | 'wan2.1-14b';
  durationSeconds?: number;
  fps?: number;
  autoReview?: boolean;
}

export interface ForgeRevisionOptions {
  assetId: string;
  targetVersionId?: string;
  revisionPrompt: string;
  scope?: EditScope;
  maskBase64?: string;
  denoise?: number;
  entityId?: string;
  entityWeight?: number;
  autoReview?: boolean;
}

export interface ForgeAnimateOptions {
  assetId: string;
  sourceVersionId?: string;
  animationPrompt?: string;
  negativePrompt?: string;
  videoModel?: 'ltx-video' | 'wan2.1-1.3b' | 'wan2.1-14b';
  fps?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  denoise?: number;
  autoReview?: boolean;
}

// ─── Phase 4: Multi-Shot Storyboard & Video Continuity Sequences ─────────────────

export type ShotType =
  | 'establishing'
  | 'wide'
  | 'medium'
  | 'close_up'
  | 'over_the_shoulder'
  | 'action';

export type CameraMovement =
  | 'static'
  | 'pan_right'
  | 'pan_left'
  | 'tilt_up'
  | 'tilt_down'
  | 'zoom_in'
  | 'zoom_out'
  | 'tracking';

export interface StoryboardShot {
  id: string;
  orderIndex: number;
  title: string;
  shotType: ShotType;
  cameraMovement: CameraMovement;
  prompt: string;
  negativePrompt?: string;
  durationSeconds: number;
  fps: number;
  entityRefs?: string[];
  sourceStillUrl?: string;
  sourceStillPath?: string;
  videoUrl?: string;
  videoPath?: string;
  handoffFrameUrl?: string;
  handoffFramePath?: string;
  status: 'draft' | 'staged' | 'generating_still' | 'generating_video' | 'completed' | 'failed';
  error?: string;
  review?: VisualReview;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardSequence {
  id: string;
  title: string;
  description: string;
  shots: StoryboardShot[];
  defaultFps: number;
  videoModel: 'ltx-video' | 'wan2.1-1.3b' | 'wan2.1-14b';
  createdAt: string;
  updatedAt: string;
}
