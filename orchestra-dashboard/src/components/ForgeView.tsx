import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookmarkPlus,
  Camera,
  Clapperboard,
  Download,
  Eye,
  Film,
  HardDriveDownload,
  Loader2,
  Paintbrush,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo,
  Users,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  CameraMovement,
  EditScope,
  EntityCategory,
  ForgeAsset,
  ForgeEntity,
  ShotType,
  StoryboardSequence,
  StoryboardShot,
  VisualReview,
} from '../../server/forge-types.js';

interface ForgeStatus {
  comfy: {
    available: boolean;
    endpoint: string;
    devices: Array<{ name: string; type: string; vramTotal: number; vramFree: number }>;
  };
  lmStudio: {
    url: string;
    model: string;
    available: boolean;
    isMultimodal: boolean;
    error?: string;
  };
}

interface ForgeDependencyStatus {
  comfyFound: boolean;
  comfyRunning: boolean;
  readyFor3D: boolean;
  missingCount: number;
  missingBytes: number;
  items: Array<{
    id: string;
    name: string;
    category: string;
    installed: boolean;
    description: string;
    required: boolean;
    sizeBytes?: number;
  }>;
}

interface ForgeViewProps {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
}

const STYLE_PRESETS = [
  { id: 'photorealistic', name: 'Photorealistic PBR', promptSuffix: ', highly detailed photorealistic 8k, professional photography, 50mm f/1.8, cinematic lighting' },
  { id: 'cinematic', name: 'Cinematic 35mm', promptSuffix: ', cinematic movie still, 35mm film grain, anamorphic lens flare, moody atmosphere, masterpiece' },
  { id: 'digital_art', name: 'Concept Art', promptSuffix: ', digital concept art, octane render, dramatic lighting, artstation trending, volumetric haze' },
  { id: 'anime', name: 'Stylized Anime', promptSuffix: ', beautiful modern anime style, makoto shinkai aesthetic, vibrant colors, clean lineart' },
];

export const ForgeView: React.FC<ForgeViewProps> = ({ api }) => {
  const [status, setStatus] = useState<ForgeStatus | null>(null);
  const [setupStatus, setSetupStatus] = useState<ForgeDependencyStatus | null>(null);
  const [installingDep, setInstallingDep] = useState<string | null>(null);

  const [assets, setAssets] = useState<ForgeAsset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<ForgeAsset | null>(null);
  const [activeVersionId, setActiveVersionId] = useState<string>('v1');

  // Entities & Cast State (Phase 3)
  const [entities, setEntities] = useState<ForgeEntity[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string>('');
  const [entityWeight, setEntityWeight] = useState<number>(0.8);
  const [showNewEntityModal, setShowNewEntityModal] = useState(false);
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityCategory, setNewEntityCategory] = useState<EntityCategory>('character');
  const [newEntityTrigger, setNewEntityTrigger] = useState('');
  const [newEntityDesc, setNewEntityDesc] = useState('');

  // Storyboard Sequences State (Phase 4)
  const [storyboards, setStoryboards] = useState<StoryboardSequence[]>([]);
  const [activeStoryboardId, setActiveStoryboardId] = useState<string>('');
  const [renderingShotId, setRenderingShotId] = useState<string | null>(null);
  const [renderingSequence, setRenderingSequence] = useState(false);
  const [showAddShotModal, setShowAddShotModal] = useState(false);
  const [newShotPrompt, setNewShotPrompt] = useState('');
  const [newShotType, setNewShotType] = useState<ShotType>('medium');
  const [newShotCamera, setNewShotCamera] = useState<CameraMovement>('pan_right');
  const [newShotEntityId, setNewShotEntityId] = useState('');

  // Primary Workflow Mode
  const [mode, setMode] = useState<'create' | 'revise' | 'animate' | 'entities' | 'storyboard'>('create');

  // Generation Inputs
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('photorealistic');
  const [generating, setGenerating] = useState(false);

  // Revision Inputs
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [editScope, setEditScope] = useState<EditScope>('localized');
  const [denoise, setDenoise] = useState(0.85);
  const [revising, setRevising] = useState(false);

  // Video Animation Inputs
  const [animationPrompt, setAnimationPrompt] = useState('cinematic camera slow pan right, smooth motion, high visual quality');
  const [videoModel, setVideoModel] = useState<'ltx-video' | 'wan2.1-1.3b'>('ltx-video');
  const [animating, setAnimating] = useState(false);

  // Inpainting Canvas & Brush State
  const [isBrushActive, setIsBrushActive] = useState(false);
  const [brushSize, setBrushSize] = useState(35);
  const [isDrawing, setIsDrawing] = useState(false);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasMaskDrawn, setHasMaskDrawn] = useState(false);

  // Viewport Pan/Zoom State
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });

  // Vision Review State
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState('');

  // 1. Fetch Engine Status, Assets, Entities, Storyboards
  const loadStatus = useCallback(async () => {
    try {
      const st = await api<ForgeStatus>('/api/forge3d/status');
      setStatus(st);
      const setup = await api<ForgeDependencyStatus>('/api/forge3d/setup/status');
      setSetupStatus(setup);
    } catch (err) {
      console.warn('Failed to probe Forge engine status:', err);
    }
  }, [api]);

  const loadAssets = useCallback(async () => {
    try {
      const list = await api<ForgeAsset[]>('/api/forge/assets');
      setAssets(list);
      if (list.length > 0 && !selectedAsset) {
        setSelectedAsset(list[0]);
        setActiveVersionId(list[0].activeVersionId || list[0].versions[0]?.versionId || 'v1');
      }
    } catch (err) {
      console.warn('Failed to load visual assets:', err);
    }
  }, [api, selectedAsset]);

  const loadEntities = useCallback(async () => {
    try {
      const list = await api<ForgeEntity[]>('/api/forge/entities');
      setEntities(list);
    } catch (err) {
      console.warn('Failed to load entities:', err);
    }
  }, [api]);

  const loadStoryboards = useCallback(async () => {
    try {
      const list = await api<StoryboardSequence[]>('/api/forge/storyboards');
      setStoryboards(list);
      if (list.length > 0 && !activeStoryboardId) {
        setActiveStoryboardId(list[0].id);
      }
    } catch (err) {
      console.warn('Failed to load storyboards:', err);
    }
  }, [api, activeStoryboardId]);

  useEffect(() => {
    void loadStatus();
    void loadAssets();
    void loadEntities();
    void loadStoryboards();
    const timer = setInterval(() => {
      void loadStatus();
    }, 10000);
    return () => clearInterval(timer);
  }, [loadStatus, loadAssets, loadEntities, loadStoryboards]);

  // Active Storyboard & Version Resolution
  const activeStoryboard = storyboards.find((s) => s.id === activeStoryboardId) || storyboards[0];
  const activeVersion = selectedAsset?.versions.find((v) => v.versionId === activeVersionId) || selectedAsset?.versions[0];
  const isVideoVersion = activeVersion?.operationType === 'animate' || activeVersion?.outputUrl?.endsWith('.mp4') || activeVersion?.outputUrl?.endsWith('.webp');

  // Dependency Installer
  const handleInstallDep = async (depId: string) => {
    try {
      setInstallingDep(depId);
      await api('/api/forge3d/setup/install', {
        method: 'POST',
        body: JSON.stringify({ depId }),
      });
      const interval = setInterval(async () => {
        const p = await api<any>('/api/forge3d/setup/progress');
        if (!p?.progress) {
          clearInterval(interval);
          setInstallingDep(null);
          void loadStatus();
        }
      }, 1000);
    } catch (err) {
      setError(`Installation failed: ${err instanceof Error ? err.message : String(err)}`);
      setInstallingDep(null);
    }
  };

  // Automatic Gemma Vision Review Helper
  const runAutoReview = async (asset: ForgeAsset, versionId: string) => {
    const version = asset.versions.find((v) => v.versionId === versionId);
    if (!version) return;
    try {
      setReviewing(true);
      const imgRes = await fetch(version.outputUrl);
      const blob = await imgRes.blob();
      const reader = new FileReader();
      const b64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => resolve(String(reader.result).replace(/^data:image\/\w+;base64,/, ''));
        reader.readAsDataURL(blob);
      });
      const imageBase64 = await b64Promise;

      let review: VisualReview;
      if (version.parentVersionId && version.changeDescription) {
        const parentVersion = asset.versions.find((v) => v.versionId === version.parentVersionId);
        if (parentVersion) {
          const parentRes = await fetch(parentVersion.outputUrl);
          const parentBlob = await parentRes.blob();
          const parentReader = new FileReader();
          const parentB64 = await new Promise<string>((resolve) => {
            parentReader.onloadend = () => resolve(String(parentReader.result).replace(/^data:image\/\w+;base64,/, ''));
            parentReader.readAsDataURL(parentBlob);
          });
          review = await api<VisualReview>('/api/forge/review/revision', {
            method: 'POST',
            body: JSON.stringify({
              requestedChange: version.changeDescription,
              originalImageBase64: parentB64,
              revisedImageBase64: imageBase64,
            }),
          });
        } else {
          review = await api<VisualReview>('/api/forge/review/creation', {
            method: 'POST',
            body: JSON.stringify({
              prompt: version.params.prompt,
              imageBase64,
            }),
          });
        }
      } else {
        review = await api<VisualReview>('/api/forge/review/creation', {
          method: 'POST',
          body: JSON.stringify({
            prompt: version.params.prompt,
            imageBase64,
          }),
        });
      }

      const updated: ForgeAsset = {
        ...asset,
        versions: asset.versions.map((v) => (v.versionId === versionId ? { ...v, review } : v)),
      };
      setSelectedAsset(updated);
      setAssets((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err) {
      console.warn('Auto-review completed with warning:', err);
    } finally {
      setReviewing(false);
    }
  };

  // Generation Handler
  const handleGenerate = async () => {
    if (!prompt.trim() || generating) return;
    try {
      setGenerating(true);
      setError('');
      const preset = STYLE_PRESETS.find((p) => p.id === selectedStyle);
      const fullPrompt = `${prompt.trim()}${preset ? preset.promptSuffix : ''}`;

      const asset = await api<ForgeAsset>('/api/forge/generate', {
        method: 'POST',
        body: JSON.stringify({
          prompt: fullPrompt,
          negativePrompt: negativePrompt.trim() || undefined,
          style: selectedStyle,
          entityId: selectedEntityId || undefined,
          entityWeight: selectedEntityId ? entityWeight : undefined,
        }),
      });
      setAssets((prev) => [asset, ...prev]);
      setSelectedAsset(asset);
      setActiveVersionId('v1');
      setMode('revise');
      setPrompt('');
      // Trigger automatic Gemma Vision QA review right after generation
      runAutoReview(asset, 'v1');
    } catch (err) {
      setError(`Generation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  // Targeted Revision Handler
  const handleRevise = async () => {
    if (!selectedAsset || !revisionPrompt.trim() || revising) return;
    try {
      setRevising(true);
      setError('');

      let maskBase64: string | undefined;
      if (editScope === 'localized' && maskCanvasRef.current && hasMaskDrawn) {
        maskBase64 = maskCanvasRef.current.toDataURL('image/png');
      }

      const updatedAsset = await api<ForgeAsset>('/api/forge/revise', {
        method: 'POST',
        body: JSON.stringify({
          assetId: selectedAsset.id,
          targetVersionId: activeVersionId,
          revisionPrompt: revisionPrompt.trim(),
          scope: editScope,
          maskBase64,
          denoise,
        }),
      });

      setAssets((prev) => prev.map((a) => (a.id === updatedAsset.id ? updatedAsset : a)));
      setSelectedAsset(updatedAsset);
      setActiveVersionId(updatedAsset.activeVersionId);
      setRevisionPrompt('');
      clearMask();
      // Trigger automatic Gemma Vision QA review right after surgical revision
      runAutoReview(updatedAsset, updatedAsset.activeVersionId);
    } catch (err) {
      setError(`Revision failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRevising(false);
    }
  };

  // Video Animation Handler
  const handleAnimate = async () => {
    if (!selectedAsset || animating) return;
    try {
      setAnimating(true);
      setError('');

      const updatedAsset = await api<ForgeAsset>('/api/forge/animate', {
        method: 'POST',
        body: JSON.stringify({
          assetId: selectedAsset.id,
          sourceVersionId: activeVersionId,
          animationPrompt: animationPrompt.trim(),
          videoModel,
          fps: 24,
        }),
      });

      setAssets((prev) => prev.map((a) => (a.id === updatedAsset.id ? updatedAsset : a)));
      setSelectedAsset(updatedAsset);
      setActiveVersionId(updatedAsset.activeVersionId);
    } catch (err) {
      setError(`Animation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAnimating(false);
    }
  };

  // Save Character Roster
  const handleSaveAsEntity = async () => {
    if (!selectedAsset || !activeVersion) return;
    const name = window.prompt('Enter Character or Prop Name:', selectedAsset.title.slice(0, 20));
    if (!name?.trim()) return;

    try {
      const entity = await api<ForgeEntity>('/api/forge/entities/from-asset', {
        method: 'POST',
        body: JSON.stringify({
          assetId: selectedAsset.id,
          versionId: activeVersionId,
          name: name.trim(),
          category: 'character',
        }),
      });
      setEntities((prev) => [entity, ...prev]);
      setSelectedEntityId(entity.id);
      window.alert(`Saved "${entity.name}" to Cast & Props Roster!`);
    } catch (err) {
      setError(`Failed to save entity: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Create Custom Entity
  const handleCreateEntity = async () => {
    if (!newEntityName.trim()) return;
    try {
      const entity = await api<ForgeEntity>('/api/forge/entities', {
        method: 'POST',
        body: JSON.stringify({
          name: newEntityName.trim(),
          category: newEntityCategory,
          description: newEntityDesc.trim(),
          triggerWord: newEntityTrigger.trim() || undefined,
        }),
      });
      setEntities((prev) => [entity, ...prev]);
      setShowNewEntityModal(false);
      setNewEntityName('');
      setNewEntityTrigger('');
      setNewEntityDesc('');
    } catch (err) {
      setError(`Failed to create entity: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Storyboard Handlers
  const handleCreateStoryboard = async () => {
    const title = window.prompt('Storyboard Title:', 'Scene 1: Cyberpunk Encounter');
    if (!title?.trim()) return;
    try {
      const seq = await api<StoryboardSequence>('/api/forge/storyboards', {
        method: 'POST',
        body: JSON.stringify({ title: title.trim() }),
      });
      setStoryboards((prev) => [seq, ...prev]);
      setActiveStoryboardId(seq.id);
    } catch (err) {
      setError(`Failed to create storyboard: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleAddShot = async () => {
    if (!activeStoryboard || !newShotPrompt.trim()) return;
    try {
      const shot = await api<StoryboardShot>(`/api/forge/storyboards/${activeStoryboard.id}/shots`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: newShotPrompt.trim(),
          shotType: newShotType,
          cameraMovement: newShotCamera,
          entityRefs: newShotEntityId ? [newShotEntityId] : [],
        }),
      });
      const updated = { ...activeStoryboard, shots: [...activeStoryboard.shots, shot] };
      setStoryboards((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setShowAddShotModal(false);
      setNewShotPrompt('');
    } catch (err) {
      setError(`Failed to add shot: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRenderShot = async (shotId: string) => {
    if (!activeStoryboard || renderingShotId) return;
    try {
      setRenderingShotId(shotId);
      setError('');
      const updatedShot = await api<StoryboardShot>(`/api/forge/storyboards/${activeStoryboard.id}/shots/${shotId}/render`, {
        method: 'POST',
      });
      const updated = {
        ...activeStoryboard,
        shots: activeStoryboard.shots.map((s) => (s.id === shotId ? updatedShot : s)),
      };
      setStoryboards((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setError(`Shot render failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRenderingShotId(null);
    }
  };

  const handleRenderSequence = async () => {
    if (!activeStoryboard || renderingSequence) return;
    try {
      setRenderingSequence(true);
      setError('');
      const updatedSeq = await api<StoryboardSequence>(`/api/forge/storyboards/${activeStoryboard.id}/render`, {
        method: 'POST',
      });
      setStoryboards((prev) => prev.map((s) => (s.id === updatedSeq.id ? updatedSeq : s)));
    } catch (err) {
      setError(`Sequence render failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRenderingSequence(false);
    }
  };

  const handleRevert = async (versionId: string) => {
    if (!selectedAsset) return;
    try {
      const updated = await api<ForgeAsset>(`/api/forge/assets/${selectedAsset.id}/revert`, {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      });
      setSelectedAsset(updated);
      setActiveVersionId(versionId);
      setAssets((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch (err) {
      setError(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const triggerCreationReview = async () => {
    if (!selectedAsset || !activeVersion || reviewing) return;
    try {
      setReviewing(true);
      setError('');
      const imgRes = await fetch(activeVersion.outputUrl);
      const blob = await imgRes.blob();
      const reader = new FileReader();
      const b64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => resolve(String(reader.result).replace(/^data:image\/\w+;base64,/, ''));
        reader.readAsDataURL(blob);
      });
      const imageBase64 = await b64Promise;

      const review = await api<VisualReview>('/api/forge/review/creation', {
        method: 'POST',
        body: JSON.stringify({
          prompt: activeVersion.params.prompt,
          imageBase64,
        }),
      });

      const updatedAsset: ForgeAsset = {
        ...selectedAsset,
        versions: selectedAsset.versions.map((v) => (v.versionId === activeVersionId ? { ...v, review } : v)),
      };
      setSelectedAsset(updatedAsset);
      setAssets((prev) => prev.map((a) => (a.id === updatedAsset.id ? updatedAsset : a)));
    } catch (err) {
      setError(`Vision review failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReviewing(false);
    }
  };

  const handleApplyRepairToRevise = () => {
    if (!activeVersion?.review) return;
    const review = activeVersion.review;
    setMode('revise');

    const repairText =
      review.suggestedAction ||
      `Fix ${review.failureType !== 'none' ? review.failureType : 'visual artifacts'} identified in Gemma review: ${review.critique}`;
    setRevisionPrompt(repairText);

    if (review.failureType === 'anatomy' || review.failureType === 'artifact') {
      setEditScope('localized');
      setIsBrushActive(true);
    } else if (review.failureType === 'identity_drift') {
      setEditScope('regional');
    } else {
      setEditScope('structural');
    }
  };

  // Canvas Mask Helpers
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isBrushActive) return;
    setIsDrawing(true);
    draw(e);
  };
  const stopDrawing = () => setIsDrawing(false);
  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !maskCanvasRef.current || !isBrushActive) return;
    const canvas = maskCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    setHasMaskDrawn(true);
  };
  const clearMask = () => {
    if (!maskCanvasRef.current) return;
    const ctx = maskCanvasRef.current.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
    setHasMaskDrawn(false);
  };

  return (
    <div className="forge-container">
      {/* ─── Left Sidebar: Controls & Inputs ──────────────────────────────── */}
      <div className="forge-sidebar">
        <div className="forge-header">
          <div>
            <span className="eyebrow">Visual Production Suite</span>
            <h2><Sparkles size={20} className="accent" /> Forge Studio</h2>
          </div>
          <button
            className="icon-button mini"
            onClick={() => { void loadStatus(); void loadAssets(); void loadEntities(); void loadStoryboards(); }}
            title="Refresh Services"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {/* Status Card */}
        <div className="forge-status-card">
          <div className="status-item">
            <div className="status-label">
              <span className={`status-dot ${status?.comfy.available ? 'online' : 'offline'}`} />
              <strong>ComfyUI Engine</strong>
            </div>
            <span>{status?.comfy.available ? `${status.comfy.devices[0]?.name?.split(':')[1] || 'GPU Ready'}` : 'Offline (:8188)'}</span>
          </div>
          <div className="status-item">
            <div className="status-label">
              <span className={`status-dot ${status?.lmStudio.isMultimodal ? 'online' : (status?.lmStudio.available ? 'warning' : 'offline')}`} />
              <strong>Gemma Vision QA</strong>
            </div>
            <span>{status?.lmStudio.isMultimodal ? 'Vision Active' : status?.lmStudio.available ? 'Text Only' : 'Offline'}</span>
          </div>
        </div>

        {/* Setup Banner */}
        {setupStatus && setupStatus.missingCount > 0 && (
          <div className="forge-setup-banner">
            <div className="setup-header">
              <HardDriveDownload size={16} className="accent" />
              <strong>Recommended Models ({setupStatus.missingCount} available)</strong>
            </div>
            <div className="setup-list">
              {setupStatus.items.filter((i) => !i.installed).slice(0, 2).map((dep) => (
                <div key={dep.id} className="setup-row">
                  <div className="setup-meta">
                    <span>{dep.name}</span>
                    <small>{dep.sizeBytes ? `${(dep.sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB` : 'Custom Model'}</small>
                  </div>
                  <button
                    className="mini primary"
                    onClick={() => handleInstallDep(dep.id)}
                    disabled={Boolean(installingDep)}
                  >
                    {installingDep === dep.id ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                    Install
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="forge-error-box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{error}</span>
            <button onClick={() => setError('')} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }}>
              <X size={14} />
            </button>
          </div>
        )}

        {/* Mode Tabs */}
        <div className="forge-tabs" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          <button
            type="button"
            className={`tab-btn ${mode === 'create' ? 'active' : ''}`}
            onClick={() => setMode('create')}
            title="Create New Image (SDXL)"
          >
            <Plus size={13} /> Create
          </button>
          <button
            type="button"
            className={`tab-btn ${mode === 'revise' ? 'active' : ''}`}
            onClick={() => setMode('revise')}
            disabled={!selectedAsset}
            title="Targeted Revision & Surgical Inpaint"
          >
            <Wand2 size={13} /> Revise
          </button>
          <button
            type="button"
            className={`tab-btn ${mode === 'animate' ? 'active' : ''}`}
            onClick={() => setMode('animate')}
            disabled={!selectedAsset}
            title="1-Click Image-to-Video Animation"
          >
            <Film size={13} /> Animate
          </button>
          <button
            type="button"
            className={`tab-btn ${mode === 'entities' ? 'active' : ''}`}
            onClick={() => setMode('entities')}
            title="Cast & Props Roster (IP-Adapter Lock)"
          >
            <Users size={13} /> Cast
          </button>
          <button
            type="button"
            className={`tab-btn ${mode === 'storyboard' ? 'active' : ''}`}
            onClick={() => setMode('storyboard')}
            title="Multi-Shot Storyboard Director"
          >
            <Clapperboard size={13} /> Direct
          </button>
        </div>

        {/* ─── Mode Specific Forms ────────────────────────────────────────── */}
        {mode === 'create' && (
          <div className="forge-form">
            <label>Prompt Description</label>
            <textarea
              rows={3}
              placeholder="e.g. Cyberpunk mercenary standing on a rain-slicked rooftop in Neo-Tokyo, neon reflections, highly detailed..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={generating}
            />

            <label>Negative Prompt (Optional)</label>
            <input
              type="text"
              placeholder="e.g. blurry, deformed, bad anatomy, text, watermark"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              disabled={generating}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                color: 'var(--text)',
                fontSize: '11px',
              }}
            />

            <label>Visual Style Preset</label>
            <div className="preset-grid">
              {STYLE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset-btn ${selectedStyle === p.id ? 'active' : ''}`}
                  onClick={() => setSelectedStyle(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>

            {entities.length > 0 && (
              <div>
                <label style={{ display: 'block', marginBottom: '6px' }}>Attach Character / Prop Lock (IP-Adapter)</label>
                <select
                  value={selectedEntityId}
                  onChange={(e) => setSelectedEntityId(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    color: 'var(--text)',
                    fontSize: '11px',
                  }}
                >
                  <option value="">None (Standard Generation)</option>
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name} ({ent.category}) {ent.referenceImages.length > 0 ? '✓' : ''}
                    </option>
                  ))}
                </select>

                {selectedEntityId && (
                  <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '10px', color: 'var(--muted)' }}>Identity Lock: {entityWeight.toFixed(2)}</span>
                    <input
                      type="range"
                      min="0.2"
                      max="1.0"
                      step="0.05"
                      value={entityWeight}
                      onChange={(e) => setEntityWeight(Number(e.target.value))}
                      style={{ width: '120px' }}
                    />
                  </div>
                )}
              </div>
            )}

            <button
              className="primary forge-btn"
              onClick={handleGenerate}
              disabled={!prompt.trim() || generating}
            >
              {generating ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
              {generating ? 'Synthesizing Image...' : 'Generate New Image'}
            </button>
          </div>
        )}

        {mode === 'revise' && selectedAsset && (
          <div className="forge-form">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label>Targeted Change Request</label>
              <span style={{ fontSize: '10px', color: 'var(--cyan)', fontWeight: 600 }}>Active: {activeVersionId}</span>
            </div>
            <textarea
              rows={2}
              placeholder="e.g. Make his jacket red, remove the person in the background, change lighting to sunset..."
              value={revisionPrompt}
              onChange={(e) => setRevisionPrompt(e.target.value)}
              disabled={revising}
            />

            <label>Edit Scope</label>
            <div className="preset-grid">
              <button
                type="button"
                className={`preset-btn ${editScope === 'localized' ? 'active' : ''}`}
                onClick={() => { setEditScope('localized'); setDenoise(0.85); }}
              >
                Localized Mask Inpaint
              </button>
              <button
                type="button"
                className={`preset-btn ${editScope === 'structural' ? 'active' : ''}`}
                onClick={() => { setEditScope('structural'); setDenoise(0.45); }}
              >
                Structural Img2Img
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
              <label style={{ margin: 0 }}>Denoise Strength: {denoise.toFixed(2)}</label>
              <input
                type="range"
                min="0.10"
                max="0.95"
                step="0.05"
                value={denoise}
                onChange={(e) => setDenoise(Number(e.target.value))}
                style={{ width: '120px' }}
              />
            </div>

            <button
              className="primary forge-btn"
              onClick={handleRevise}
              disabled={!revisionPrompt.trim() || revising}
            >
              {revising ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />}
              {revising ? 'Applying Revision...' : 'Apply Revision (Non-Destructive)'}
            </button>
          </div>
        )}

        {mode === 'animate' && selectedAsset && (
          <div className="forge-form">
            <label>Camera & Motion Prompt</label>
            <textarea
              rows={2}
              placeholder="e.g. cinematic camera slow pan right, wheels spinning smoothly, headlights illuminating road..."
              value={animationPrompt}
              onChange={(e) => setAnimationPrompt(e.target.value)}
              disabled={animating}
            />

            <label>Video Generation Model</label>
            <select
              value={videoModel}
              onChange={(e) => setVideoModel(e.target.value as any)}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                color: 'var(--text)',
                fontSize: '11px',
              }}
            >
              <option value="ltx-video">LTX-Video 2B Distilled (Fast 24 FPS, ~25s)</option>
              <option value="wan2.1-1.3b">Wan 2.1 1.3B (Motion Quality, ~60s)</option>
            </select>

            <button
              className="primary forge-btn"
              onClick={handleAnimate}
              disabled={animating}
            >
              {animating ? <Loader2 size={15} className="spin" /> : <Film size={15} />}
              {animating ? 'Rendering Video Animation...' : 'Render Animation (I2V)'}
            </button>
          </div>
        )}

        {mode === 'entities' && (
          <div className="forge-form">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label>Cast & Props Roster ({entities.length})</label>
              <button
                type="button"
                className="mini primary"
                onClick={() => setShowNewEntityModal(true)}
              >
                <Plus size={11} /> New Entity
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
              {entities.map((ent) => (
                <div
                  key={ent.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    background: 'rgba(0,0,0,0.2)',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Users size={14} className="accent" />
                    <div>
                      <strong style={{ fontSize: '11px', display: 'block' }}>{ent.name}</strong>
                      <small style={{ fontSize: '9px', color: 'var(--muted)' }}>{ent.category}</small>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="mini secondary"
                    onClick={() => {
                      setSelectedEntityId(selectedEntityId === ent.id ? '' : ent.id);
                      setMode('create');
                    }}
                  >
                    {selectedEntityId === ent.id ? 'Attached' : 'Use in Scene'}
                  </button>
                </div>
              ))}
              {entities.length === 0 && (
                <small style={{ color: 'var(--muted)', textAlign: 'center', padding: '10px' }}>
                  No saved characters yet. Click "+ New Entity" or "Save as Character" in the viewport.
                </small>
              )}
            </div>
          </div>
        )}

        {mode === 'storyboard' && (
          <div className="forge-form">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label>Storyboard Sequences ({storyboards.length})</label>
              <button type="button" className="mini primary" onClick={handleCreateStoryboard}>
                <Plus size={11} /> New Scene
              </button>
            </div>
            <select
              value={activeStoryboardId}
              onChange={(e) => setActiveStoryboardId(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                color: 'var(--text)',
                fontSize: '11px',
              }}
            >
              {storyboards.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.shots.length} shots)
                </option>
              ))}
            </select>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <button
                type="button"
                className="secondary"
                onClick={() => setShowAddShotModal(true)}
              >
                <Plus size={12} /> Add Shot
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleRenderSequence}
                disabled={renderingSequence || !activeStoryboard || activeStoryboard.shots.length === 0}
              >
                {renderingSequence ? <Loader2 size={12} className="spin" /> : <Film size={12} />}
                Render All
              </button>
            </div>
          </div>
        )}

        {/* ─── Asset Library List ─────────────────────────────────────────── */}
        <div className="forge-library">
          <div className="library-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>GENERATED ASSETS</span>
            <span>{assets.length} items</span>
          </div>
          <div className="asset-list">
            {assets.map((asset) => {
              const activeVer = asset.versions.find((v) => v.versionId === asset.activeVersionId) || asset.versions[0];
              const isSelected = selectedAsset?.id === asset.id;
              const hasVideo = asset.versions.some((v) => v.operationType === 'animate');
              return (
                <div
                  key={asset.id}
                  className={`asset-card ${isSelected ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedAsset(asset);
                    setActiveVersionId(asset.activeVersionId || asset.versions[0]?.versionId || 'v1');
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <div style={{ width: '32px', height: '32px', borderRadius: '4px', overflow: 'hidden', background: '#000', flexShrink: 0, position: 'relative' }}>
                      <img src={activeVer?.outputUrl} alt={asset.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      {hasVideo && (
                        <div style={{ position: 'absolute', top: 1, right: 1, background: 'var(--blue)', borderRadius: '2px', padding: '1px' }}>
                          <Film size={8} color="#fff" />
                        </div>
                      )}
                    </div>
                    <div className="asset-card-info">
                      <strong>{asset.title}</strong>
                      <small>{asset.versions.length} version(s) • {new Date(asset.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
                    </div>
                  </div>
                  <div className="asset-card-actions">
                    <button
                      className="icon-button mini"
                      onClick={(e) => {
                        e.stopPropagation();
                        void api(`/api/forge/assets/${asset.id}`, { method: 'DELETE' });
                        setAssets((prev) => prev.filter((a) => a.id !== asset.id));
                        if (selectedAsset?.id === asset.id) setSelectedAsset(null);
                      }}
                      title="Delete Asset"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
            {assets.length === 0 && (
              <small style={{ color: 'var(--muted)', textAlign: 'center', padding: '16px' }}>
                No assets generated yet.<br />Enter a prompt above to create your first visual asset.
              </small>
            )}
          </div>
        </div>
      </div>

      {/* ─── Right Viewport Area: 2D Canvas / Video / Storyboard Timeline ─── */}
      <div className="forge-viewport-area">
        {/* Top Viewport Toolbar */}
        <div className="viewport-toolbar">
          <div className="viewport-title">
            <strong>{mode === 'storyboard' ? activeStoryboard?.title || 'Storyboard Sequence' : selectedAsset?.title || 'Visual Canvas'}</strong>
            {activeVersion && (
              <span className="pill" style={{ color: 'var(--cyan)' }}>
                {activeVersion.versionId} • {activeVersion.operationType}
              </span>
            )}
          </div>

          <div className="viewport-controls">
            {mode !== 'storyboard' && !isVideoVersion && (
              <>
                <button
                  className={`mini-btn ${isBrushActive ? 'primary' : 'secondary'}`}
                  onClick={() => setIsBrushActive(!isBrushActive)}
                  title="Paint Inpaint Mask"
                >
                  <Paintbrush size={12} />
                  Mask Brush
                </button>
                {isBrushActive && (
                  <>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      value={brushSize}
                      onChange={(e) => setBrushSize(Number(e.target.value))}
                      style={{ width: '70px' }}
                      title={`Brush size: ${brushSize}px`}
                    />
                    <button className="icon-button mini" onClick={clearMask} title="Clear Mask">
                      <Undo size={12} />
                    </button>
                  </>
                )}
                <button
                  className="mini-btn secondary"
                  onClick={handleSaveAsEntity}
                  disabled={!selectedAsset}
                  title="Save this character to Cast Roster"
                >
                  <BookmarkPlus size={12} />
                  Save as Character
                </button>
              </>
            )}
            {mode !== 'storyboard' && (
              <>
                <button className="icon-button mini" onClick={() => setZoom((z) => Math.min(3, z + 0.2))} title="Zoom In">
                  <ZoomIn size={14} />
                </button>
                <button className="icon-button mini" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} title="Zoom Out">
                  <ZoomOut size={14} />
                </button>
                <button className="icon-button mini" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="Reset View">
                  <RotateCcw size={14} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Central Viewport Content */}
        {mode === 'storyboard' ? (
          /* ─── Storyboard Visual Strip & Continuity Lineage ─────────────── */
          <div style={{ flex: 1, padding: '24px', overflowX: 'auto', overflowY: 'hidden', display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', minWidth: 'max-content' }}>
              {activeStoryboard?.shots.map((shot, idx) => {
                const isRenderingThis = renderingShotId === shot.id;
                const nextShot = activeStoryboard.shots[idx + 1];
                return (
                  <React.Fragment key={shot.id}>
                    <div
                      style={{
                        width: '280px',
                        background: 'var(--card)',
                        border: '1px solid var(--border)',
                        borderRadius: '12px',
                        padding: '14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: '12px' }}>Shot {shot.orderIndex}: {shot.title}</strong>
                        <span className="pill" style={{ fontSize: '9px' }}>{shot.status}</span>
                      </div>

                      <div style={{ height: '150px', background: '#000', borderRadius: '8px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {shot.videoUrl ? (
                          <video src={shot.videoUrl} autoPlay loop muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : shot.sourceStillUrl ? (
                          <img src={shot.sourceStillUrl} alt={shot.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <div style={{ color: 'var(--muted)', fontSize: '11px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                            <Camera size={24} />
                            Not Rendered
                          </div>
                        )}
                      </div>

                      <p style={{ fontSize: '11px', color: 'var(--muted)', margin: 0, lineHeight: 1.4 }}>{shot.prompt}</p>

                      <div style={{ display: 'flex', gap: '6px', fontSize: '9px' }}>
                        <span className="pill">{shot.shotType}</span>
                        <span className="pill" style={{ color: 'var(--cyan)' }}>{shot.cameraMovement}</span>
                      </div>

                      <button
                        className="primary mini-btn"
                        onClick={() => handleRenderShot(shot.id)}
                        disabled={Boolean(renderingShotId) || renderingSequence}
                        style={{ width: '100%', justifyContent: 'center', padding: '6px' }}
                      >
                        {isRenderingThis ? <Loader2 size={12} className="spin" /> : <Film size={12} />}
                        {isRenderingThis ? 'Rendering...' : 'Render Shot'}
                      </button>
                    </div>

                    {nextShot && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: 'var(--blue)' }}>
                        <ArrowRight size={20} />
                        <span style={{ fontSize: '9px', color: 'var(--muted)', marginTop: '2px' }}>Handoff</span>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}

              {activeStoryboard?.shots.length === 0 && (
                <div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center', width: '100%' }}>
                  No shots in this sequence yet. Click "+ Add Shot" in the sidebar to start directing.
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ─── 2D Canvas / Video Player Viewport ────────────────────────── */
          <div
            style={{
              flex: 1,
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              cursor: isBrushActive ? 'crosshair' : isPanning ? 'grabbing' : 'grab',
            }}
            onMouseDown={(e) => {
              if (!isBrushActive && e.button === 0) {
                setIsPanning(true);
                setStartPan({ x: e.clientX - pan.x, y: e.clientY - pan.y });
              }
            }}
            onMouseMove={(e) => {
              if (isPanning) {
                setPan({ x: e.clientX - startPan.x, y: e.clientY - startPan.y });
              }
            }}
            onMouseUp={() => setIsPanning(false)}
            onMouseLeave={() => setIsPanning(false)}
          >
            {activeVersion ? (
              <div
                style={{
                  position: 'relative',
                  transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
                  transition: isPanning ? 'none' : 'transform 0.1s ease-out',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
                  border: '1px solid var(--border)',
                }}
              >
                {isVideoVersion && activeVersion.outputUrl.endsWith('.mp4') ? (
                  <video
                    src={activeVersion.outputUrl}
                    controls
                    autoPlay
                    loop
                    playsInline
                    style={{ maxHeight: '600px', maxWidth: '600px', objectFit: 'contain' }}
                  />
                ) : (
                  <img
                    src={activeVersion.outputUrl}
                    alt={activeVersion.changeDescription}
                    style={{ maxHeight: '600px', maxWidth: '600px', objectFit: 'contain', display: 'block', userSelect: 'none' }}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      if (maskCanvasRef.current) {
                        maskCanvasRef.current.width = img.naturalWidth || 1024;
                        maskCanvasRef.current.height = img.naturalHeight || 1024;
                      }
                    }}
                  />
                )}

                {/* Inpainting Mask Canvas Overlay */}
                {!isVideoVersion && (
                  <canvas
                    ref={maskCanvasRef}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: '100%',
                      opacity: 0.6,
                      pointerEvents: isBrushActive ? 'auto' : 'none',
                    }}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                  />
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: 'var(--muted)' }}>
                <Sparkles size={36} className="accent" />
                <strong style={{ color: 'var(--text)' }}>Forge Canvas Ready</strong>
                <span style={{ fontSize: '12px' }}>Enter a prompt on the left to generate your first image.</span>
              </div>
            )}
          </div>
        )}

        {/* ─── Bottom Viewport Overlay: Version DAG & Quality Review ───────── */}
        {selectedAsset && mode !== 'storyboard' && (
          <div className="viewport-overlay-panel">
            {/* Version DAG Pill Strip */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'rgba(15, 23, 42, 0.85)',
                backdropFilter: 'blur(12px)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '6px 12px',
                overflowX: 'auto',
              }}
            >
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Version Lineage:</span>
              {selectedAsset.versions.map((ver) => {
                const isActive = ver.versionId === activeVersionId;
                return (
                  <button
                    key={ver.versionId}
                    type="button"
                    className={`mode-btn ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveVersionId(ver.versionId)}
                    style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px' }}
                  >
                    {ver.operationType === 'animate' ? <Film size={10} /> : ver.versionId}
                    <span>{ver.changeDescription.slice(0, 18)}</span>
                  </button>
                );
              })}
              {activeVersionId !== 'v1' && (
                <button
                  type="button"
                  className="mini-btn secondary"
                  onClick={() => handleRevert(activeVersionId)}
                  style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: '10px' }}
                >
                  <RotateCcw size={10} /> Revert to this
                </button>
              )}
            </div>

            {/* Gemma Vision Review Bar */}
            <div className="vision-critique-card">
              <div className="critique-header">
                <Eye size={14} className="accent" />
                <strong>Gemma Vision QA Review</strong>
                <button
                  type="button"
                  className="mini-btn secondary"
                  onClick={triggerCreationReview}
                  disabled={reviewing}
                  style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: '10px' }}
                >
                  {reviewing ? <Loader2 size={10} className="spin" /> : <Eye size={10} />}
                  Inspect Active Version
                </button>
                {activeVersion?.review && (
                  <span className={`review-tag ${activeVersion.review.verdict === 'pass' ? 'pass' : 'warning'}`} style={{ marginLeft: '8px' }}>
                    {activeVersion.review.score}/100 {activeVersion.review.verdict.toUpperCase()}
                  </span>
                )}
              </div>
              {activeVersion?.review ? (
                <div>
                  <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--muted)', lineHeight: 1.4 }}>
                    {activeVersion.review.critique}
                  </p>
                  {activeVersion.review.suggestedAction && (
                    <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--cyan)' }}>
                      <strong>Suggested Repair:</strong> {activeVersion.review.suggestedAction}
                    </div>
                  )}
                  {activeVersion.review.verdict === 'needs_repair' && (
                    <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <button
                        type="button"
                        className="forge-btn"
                        style={{ padding: '4px 10px', fontSize: '11px', width: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                        onClick={handleApplyRepairToRevise}
                      >
                        <Wand2 size={12} /> Apply Repair to Revise
                      </button>
                      <span style={{ fontSize: '10px', color: 'var(--muted)' }}>
                        Populates repair prompt & selects mask brush
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <small style={{ color: 'var(--muted)' }}>
                  Click "Inspect Active Version" above to trigger an independent multimodal quality critique.
                </small>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ─── Modal: Add Shot (Phase 4) ────────────────────────────────────── */}
      {showAddShotModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ width: '100%', maxWidth: '420px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>Add Shot to Storyboard</h3>
            <div>
              <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Visual Prompt</label>
              <textarea
                rows={2}
                placeholder="e.g. Captain Marcus looks up at the skybridge as vehicles streak past..."
                value={newShotPrompt}
                onChange={(e) => setNewShotPrompt(e.target.value)}
                style={{ width: '100%', padding: '8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', fontSize: '11px' }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Shot Type</label>
                <select
                  value={newShotType}
                  onChange={(e) => setNewShotType(e.target.value as any)}
                  style={{ width: '100%', padding: '6px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', fontSize: '11px' }}
                >
                  <option value="establishing">Establishing</option>
                  <option value="wide">Wide</option>
                  <option value="medium">Medium</option>
                  <option value="close_up">Close-Up</option>
                  <option value="action">Action / Tracking</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Camera Movement</label>
                <select
                  value={newShotCamera}
                  onChange={(e) => setNewShotCamera(e.target.value as any)}
                  style={{ width: '100%', padding: '6px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', fontSize: '11px' }}
                >
                  <option value="static">Static Locked</option>
                  <option value="pan_right">Pan Right</option>
                  <option value="pan_left">Pan Left</option>
                  <option value="zoom_in">Zoom In</option>
                  <option value="tracking">Forward Tracking</option>
                </select>
              </div>
            </div>
            {entities.length > 0 && (
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Attach Character / Prop</label>
                <select
                  value={newShotEntityId}
                  onChange={(e) => setNewShotEntityId(e.target.value)}
                  style={{ width: '100%', padding: '6px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', fontSize: '11px' }}
                >
                  <option value="">None (Generic)</option>
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>{ent.name} ({ent.category})</option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' }}>
              <button className="secondary" onClick={() => setShowAddShotModal(false)}>Cancel</button>
              <button className="primary" onClick={handleAddShot} disabled={!newShotPrompt.trim()}>Add Shot</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: New Cast Entity (Phase 3) ──────────────────────────────── */}
      {showNewEntityModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ width: '100%', maxWidth: '420px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>Add Character or Prop to Roster</h3>
            <div>
              <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Name</label>
              <input
                type="text"
                placeholder="e.g. Captain Marcus"
                value={newEntityName}
                onChange={(e) => setNewEntityName(e.target.value)}
                style={{ width: '100%', padding: '8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', fontSize: '11px' }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Category</label>
                <select
                  value={newEntityCategory}
                  onChange={(e) => setNewEntityCategory(e.target.value as any)}
                  style={{ width: '100%', padding: '6px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', fontSize: '11px' }}
                >
                  <option value="character">Character</option>
                  <option value="vehicle">Vehicle</option>
                  <option value="prop">Prop</option>
                  <option value="environment">Environment</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Trigger Word</label>
                <input
                  type="text"
                  placeholder="e.g. cmarcus_man"
                  value={newEntityTrigger}
                  onChange={(e) => setNewEntityTrigger(e.target.value)}
                  style={{ width: '100%', padding: '6px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', fontSize: '11px' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' }}>
              <button className="secondary" onClick={() => setShowNewEntityModal(false)}>Cancel</button>
              <button className="primary" onClick={handleCreateEntity} disabled={!newEntityName.trim()}>Save Entity</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
