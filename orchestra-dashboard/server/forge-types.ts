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
