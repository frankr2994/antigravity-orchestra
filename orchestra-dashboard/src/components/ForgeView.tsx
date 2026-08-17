import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookmarkPlus,
  Camera,
  Clapperboard,
  Eye,
  Film,
  Paintbrush,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo,
  UserPlus,
  Users,
  Wand2,
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
  }>;
}

interface ForgeViewProps {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
}

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

  // Mode: Create | Revise | Animate | Entities | Storyboard
  const [mode, setMode] = useState<'create' | 'revise' | 'animate' | 'entities' | 'storyboard'>('create');

  // Generation State
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [stylePreset, setStylePreset] = useState('photorealistic');
  const [generating, setGenerating] = useState(false);

  // Revision State
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [editScope, setEditScope] = useState<EditScope>('localized');
  const [denoise, setDenoise] = useState(0.85);
  const [revising, setRevising] = useState(false);

  // Video Animation State
  const [animationPrompt, setAnimationPrompt] = useState('cinematic camera movement, smooth motion, high visual quality');
  const [videoModel, setVideoModel] = useState<'ltx-video' | 'wan2.1-1.3b'>('ltx-video');
  const [animating, setAnimating] = useState(false);

  // Inpainting Canvas & Brush State
  const [isBrushActive, setIsBrushActive] = useState(false);
  const [brushSize, setBrushSize] = useState(30);
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
  const fetchStatus = useCallback(async () => {
    try {
      const st = await api<ForgeStatus>('/api/forge3d/status');
      setStatus(st);
      const setup = await api<ForgeDependencyStatus>('/api/forge3d/setup/status');
      setSetupStatus(setup);
    } catch (err) {
      console.warn('Failed to probe Forge engine status:', err);
    }
  }, [api]);

  const fetchAssets = useCallback(async () => {
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

  const fetchEntities = useCallback(async () => {
    try {
      const list = await api<ForgeEntity[]>('/api/forge/entities');
      setEntities(list);
    } catch (err) {
      console.warn('Failed to load entities:', err);
    }
  }, [api]);

  const fetchStoryboards = useCallback(async () => {
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
    void fetchStatus();
    void fetchAssets();
    void fetchEntities();
    void fetchStoryboards();
    const timer = setInterval(() => {
      void fetchStatus();
    }, 10000);
    return () => clearInterval(timer);
  }, [fetchStatus, fetchAssets, fetchEntities, fetchStoryboards]);

  // Active storyboard resolution
  const activeStoryboard = storyboards.find((s) => s.id === activeStoryboardId) || storyboards[0];

  // Active version resolution
  const activeVersion = selectedAsset?.versions.find((v) => v.versionId === activeVersionId) || selectedAsset?.versions[0];
  const isVideoVersion = activeVersion?.operationType === 'animate' || activeVersion?.outputUrl?.endsWith('.mp4') || activeVersion?.outputUrl?.endsWith('.webp');

  // 2. Dependency Installer
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
          void fetchStatus();
        }
      }, 1000);
    } catch (err) {
      setError(`Installation failed: ${err instanceof Error ? err.message : String(err)}`);
      setInstallingDep(null);
    }
  };

  // 3. New Generation Handler (with Optional Entity Binding)
  const handleGenerate = async () => {
    if (!prompt.trim() || generating) return;
    try {
      setGenerating(true);
      setError('');
      const asset = await api<ForgeAsset>('/api/forge/generate', {
        method: 'POST',
        body: JSON.stringify({
          prompt: prompt.trim(),
          negativePrompt: negativePrompt.trim() || undefined,
          style: stylePreset,
          entityId: selectedEntityId || undefined,
          entityWeight: selectedEntityId ? entityWeight : undefined,
        }),
      });
      setAssets((prev) => [asset, ...prev]);
      setSelectedAsset(asset);
      setActiveVersionId('v1');
      setMode('revise');
      setPrompt('');
    } catch (err) {
      setError(`Generation failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  // 4. Targeted Revision Handler
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
    } catch (err) {
      setError(`Revision failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRevising(false);
    }
  };

  // 5. Video Animation Handler
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

  // 6. Save Active Version Directly as a Persistent Entity
  const handleSaveAsEntity = async () => {
    if (!selectedAsset || !activeVersion) return;
    const name = window.prompt('Enter Character / Prop Name:', selectedAsset.title.slice(0, 20));
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
      window.alert(`Successfully saved "${entity.name}" to your Cast & Props Roster!`);
    } catch (err) {
      setError(`Failed to save entity: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 7. Create New Custom Entity
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

  // 8. Storyboard Handlers (Phase 4)
  const handleCreateStoryboard = async () => {
    const title = window.prompt('Storyboard Title:', 'Scene 1: Cyberpunk Alley Encounter');
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

  // 9. Version Revert Handler
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

  // 10. Gemma 12B Vision Review
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

  // 11. Canvas Mask Drawing Helpers
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isBrushActive) return;
    setIsDrawing(true);
    draw(e);
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

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
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {/* ─── Top Engine Status Bar ────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-6 py-2.5 backdrop-blur">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-indigo-400" />
            <h1 className="text-base font-semibold tracking-wide text-white">Forge Studio</h1>
          </div>

          <div className="flex items-center gap-4 text-xs">
            {/* Comfy Status */}
            <div className="flex items-center gap-1.5 rounded-md bg-slate-800/80 px-2.5 py-1">
              <span className={`h-2 w-2 rounded-full ${status?.comfy?.available ? 'bg-emerald-400' : 'bg-rose-500'}`} />
              <span className="font-medium text-slate-300">
                ComfyUI: {status?.comfy?.devices?.[0]?.name || (status?.comfy?.available ? 'Online' : 'Offline')}
              </span>
            </div>

            {/* LM Studio Vision Status */}
            <div className="flex items-center gap-1.5 rounded-md bg-slate-800/80 px-2.5 py-1">
              <span className={`h-2 w-2 rounded-full ${status?.lmStudio?.isMultimodal ? 'bg-emerald-400' : status?.lmStudio?.available ? 'bg-amber-400' : 'bg-slate-500'}`} />
              <span className="font-medium text-slate-300">
                Gemma Vision: {status?.lmStudio?.isMultimodal ? 'Multimodal Ready' : status?.lmStudio?.available ? 'Text Only' : 'Offline'}
              </span>
            </div>
          </div>
        </div>

        {/* Action Modes */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setMode('create'); }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
              mode === 'create' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Plus className="h-3.5 w-3.5" />
            New Image
          </button>
          <button
            onClick={() => { setMode('revise'); }}
            disabled={!selectedAsset}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
              mode === 'revise' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' : 'bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40'
            }`}
          >
            <Wand2 className="h-3.5 w-3.5" />
            Targeted Revise
          </button>
          <button
            onClick={() => { setMode('animate'); }}
            disabled={!selectedAsset}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
              mode === 'animate' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' : 'bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40'
            }`}
          >
            <Film className="h-3.5 w-3.5" />
            Animate (I2V)
          </button>
          <button
            onClick={() => { setMode('entities'); }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
              mode === 'entities' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            Cast & Props ({entities.length})
          </button>
          <button
            onClick={() => { setMode('storyboard'); }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition ${
              mode === 'storyboard' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/20' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Clapperboard className="h-3.5 w-3.5" />
            Storyboard Director ({storyboards.length})
          </button>
        </div>
      </div>

      {/* ─── 1-Click Dependency Setup Banner ─────────────────────────────── */}
      {setupStatus && setupStatus.missingCount > 0 && (
        <div className="flex items-center justify-between border-b border-amber-500/30 bg-amber-950/40 px-6 py-2 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <span>
              {setupStatus.missingCount} recommended model(s) available for full SDXL inpainting & video synthesis.
            </span>
          </div>
          <div className="flex items-center gap-2">
            {setupStatus.items.filter((i) => !i.installed).slice(0, 2).map((dep) => (
              <button
                key={dep.id}
                onClick={() => handleInstallDep(dep.id)}
                disabled={Boolean(installingDep)}
                className="rounded bg-amber-600/80 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {installingDep === dep.id ? 'Installing...' : `Install ${dep.name.split(' ')[0]}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Error Notification ───────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center justify-between bg-rose-950/80 px-6 py-2 text-xs text-rose-200 border-b border-rose-800">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-rose-400 hover:text-white">✕</button>
        </div>
      )}

      {/* ─── Storyboard Director Mode Layout (Phase 4) ─────────────────────── */}
      {mode === 'storyboard' ? (
        <div className="flex flex-1 flex-col overflow-hidden bg-slate-950">
          {/* Storyboard Header */}
          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/60 px-6 py-3">
            <div className="flex items-center gap-3">
              <select
                value={activeStoryboardId}
                onChange={(e) => setActiveStoryboardId(e.target.value)}
                className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white focus:border-indigo-500 focus:outline-none"
              >
                {storyboards.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({s.shots.length} shots)
                  </option>
                ))}
              </select>
              <button
                onClick={handleCreateStoryboard}
                className="flex items-center gap-1 rounded bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-700"
              >
                <Plus className="h-3.5 w-3.5" />
                New Sequence
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAddShotModal(true)}
                className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                <Plus className="h-3.5 w-3.5 text-indigo-400" />
                Add Shot
              </button>
              <button
                onClick={handleRenderSequence}
                disabled={renderingSequence || !activeStoryboard || activeStoryboard.shots.length === 0}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-500 disabled:opacity-50 transition"
              >
                {renderingSequence ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Film className="h-3.5 w-3.5" />}
                {renderingSequence ? 'Rendering Sequence...' : 'Render Entire Sequence'}
              </button>
            </div>
          </div>

          {/* Shot Timeline / Strip */}
          <div className="flex-1 overflow-x-auto p-6">
            <div className="flex items-start gap-4 min-w-max">
              {activeStoryboard?.shots.map((shot, idx) => {
                const isRenderingThis = renderingShotId === shot.id;
                const nextShot = activeStoryboard.shots[idx + 1];
                return (
                  <React.Fragment key={shot.id}>
                    <div className="w-80 flex-shrink-0 rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3 shadow-xl">
                      {/* Shot Header */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600/30 text-[11px] font-bold text-indigo-400 border border-indigo-500/40">
                            {shot.orderIndex}
                          </span>
                          <span className="text-xs font-semibold text-slate-200">{shot.title}</span>
                        </div>
                        <span className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          shot.status === 'completed' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : shot.status === 'failed' ? 'bg-rose-950 text-rose-300' : 'bg-slate-800 text-slate-400'
                        }`}>
                          {shot.status.replace('_', ' ')}
                        </span>
                      </div>

                      {/* Video / Still Preview */}
                      <div className="relative h-44 w-full rounded-lg overflow-hidden border border-slate-800 bg-slate-950 flex items-center justify-center">
                        {shot.videoUrl ? (
                          <video src={shot.videoUrl} autoPlay loop muted playsInline className="h-full w-full object-cover" />
                        ) : shot.sourceStillUrl ? (
                          <img src={shot.sourceStillUrl} alt={shot.title} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex flex-col items-center gap-1 text-slate-600">
                            <Camera className="h-8 w-8 stroke-[1.5]" />
                            <span className="text-[11px]">Not Rendered</span>
                          </div>
                        )}
                      </div>

                      {/* Prompt & Tags */}
                      <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">{shot.prompt}</p>

                      <div className="flex items-center gap-2 text-[10px]">
                        <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-400 font-medium">
                          {shot.shotType}
                        </span>
                        <span className="rounded bg-slate-800 px-2 py-0.5 text-indigo-300 font-medium">
                          {shot.cameraMovement.replace('_', ' ')}
                        </span>
                      </div>

                      {/* Shot Actions */}
                      <button
                        onClick={() => handleRenderShot(shot.id)}
                        disabled={Boolean(renderingShotId) || renderingSequence}
                        className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-slate-800 py-1.5 text-xs font-medium text-slate-200 hover:bg-indigo-600 hover:text-white transition disabled:opacity-50"
                      >
                        {isRenderingThis ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />}
                        {isRenderingThis ? 'Rendering...' : 'Render Shot'}
                      </button>
                    </div>

                    {/* Visual Continuity Handoff Arrow */}
                    {nextShot && (
                      <div className="flex flex-col items-center justify-center pt-24 text-indigo-400/60">
                        <ArrowRight className="h-5 w-5" />
                        <span className="text-[9px] font-mono text-slate-500 mt-1">Handoff</span>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}

              {activeStoryboard?.shots.length === 0 && (
                <div className="py-20 text-center text-xs text-slate-500 w-full">
                  No shots added to this sequence yet.<br />Click "+ Add Shot" above to create your storyboard.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* ─── Standard Workspace Layout (Create, Revise, Animate, Cast) ───── */
        <div className="flex flex-1 overflow-hidden">
          {/* ─── Left Sidebar: Asset Library ─────────────────────────────────── */}
          <div className="flex w-64 flex-col border-r border-slate-800 bg-slate-900/50">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Library</span>
              <span className="text-xs text-slate-500">{assets.length} assets</span>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {assets.map((asset) => {
                const activeVer = asset.versions.find((v) => v.versionId === asset.activeVersionId) || asset.versions[0];
                const isSelected = selectedAsset?.id === asset.id;
                const hasVideo = asset.versions.some((v) => v.operationType === 'animate');
                return (
                  <div
                    key={asset.id}
                    onClick={() => {
                      setSelectedAsset(asset);
                      setActiveVersionId(asset.activeVersionId || asset.versions[0]?.versionId || 'v1');
                    }}
                    className={`group flex cursor-pointer items-center gap-3 rounded-lg border p-2 transition ${
                      isSelected
                        ? 'border-indigo-500/80 bg-indigo-950/30'
                        : 'border-slate-800/80 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="relative h-12 w-12 rounded overflow-hidden border border-slate-700/50 bg-slate-950">
                      <img
                        src={activeVer?.outputUrl}
                        alt={asset.title}
                        className="h-full w-full object-cover"
                      />
                      {hasVideo && (
                        <div className="absolute top-0.5 right-0.5 rounded bg-indigo-600/90 p-0.5 shadow">
                          <Film className="h-2.5 w-2.5 text-white" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-xs font-medium text-slate-200">{asset.title}</p>
                      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-400">
                        <span className="rounded bg-slate-800 px-1 py-0.2">{asset.versions.length} ver</span>
                        <span>{new Date(asset.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void api(`/api/forge/assets/${asset.id}`, { method: 'DELETE' });
                        setAssets((prev) => prev.filter((a) => a.id !== asset.id));
                        if (selectedAsset?.id === asset.id) setSelectedAsset(null);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 transition"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              {assets.length === 0 && (
                <div className="py-12 text-center text-xs text-slate-500">
                  No assets generated yet.<br />Enter a prompt to create your first visual asset.
                </div>
              )}
            </div>
          </div>

          {/* ─── Center Viewport: 2D Canvas & Video Player ─────────────────── */}
          <div className="relative flex flex-1 flex-col items-center justify-center bg-slate-950 overflow-hidden">
            {/* Top Canvas Toolbar */}
            <div className="absolute top-4 left-4 z-20 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/90 p-1.5 shadow-lg backdrop-blur">
              <button
                onClick={() => setZoom((z) => Math.min(3, z + 0.2))}
                className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                title="Zoom In"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
                className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                title="Zoom Out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
                title="Reset View"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              {!isVideoVersion && (
                <>
                  <div className="h-4 w-px bg-slate-800" />
                  <button
                    onClick={() => setIsBrushActive(!isBrushActive)}
                    className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition ${
                      isBrushActive ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                    }`}
                    title="Paint Inpaint Mask"
                  >
                    <Paintbrush className="h-3.5 w-3.5" />
                    <span>Mask Brush</span>
                  </button>
                  {isBrushActive && (
                    <>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        value={brushSize}
                        onChange={(e) => setBrushSize(Number(e.target.value))}
                        className="w-16 h-1 bg-slate-700 rounded cursor-pointer"
                        title={`Brush size: ${brushSize}px`}
                      />
                      <button
                        onClick={clearMask}
                        className="rounded p-1 text-slate-400 hover:text-rose-400"
                        title="Clear Inpaint Mask"
                      >
                        <Undo className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                  <div className="h-4 w-px bg-slate-800" />
                  <button
                    onClick={handleSaveAsEntity}
                    disabled={!selectedAsset}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-amber-300 hover:bg-amber-950/40 hover:text-amber-200 transition"
                    title="Save this version into Cast & Props Reference Roster"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    <span>Save as Character</span>
                  </button>
                </>
              )}
            </div>

            {/* Main Display Area (Image or Video) */}
            <div
              className="relative flex items-center justify-center w-full h-full cursor-grab active:cursor-grabbing select-none"
              style={{
                transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
                transition: isPanning ? 'none' : 'transform 0.1s ease-out',
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
                <div className="relative rounded-lg shadow-2xl overflow-hidden border border-slate-800">
                  {isVideoVersion && activeVersion.outputUrl.endsWith('.mp4') ? (
                    <video
                      src={activeVersion.outputUrl}
                      controls
                      autoPlay
                      loop
                      playsInline
                      className="max-h-[600px] max-w-[600px] object-contain rounded"
                    />
                  ) : (
                    <img
                      src={activeVersion.outputUrl}
                      alt={activeVersion.changeDescription}
                      className="max-h-[600px] max-w-[600px] object-contain pointer-events-none rounded"
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        if (maskCanvasRef.current) {
                          maskCanvasRef.current.width = img.naturalWidth || 1024;
                          maskCanvasRef.current.height = img.naturalHeight || 1024;
                        }
                      }}
                    />
                  )}

                  {/* Inpainting Mask Paint Canvas Overlay (Only for still images) */}
                  {!isVideoVersion && (
                    <canvas
                      ref={maskCanvasRef}
                      className={`absolute inset-0 h-full w-full opacity-60 ${isBrushActive ? 'cursor-crosshair z-10' : 'pointer-events-none'}`}
                      onMouseDown={startDrawing}
                      onMouseMove={draw}
                      onMouseUp={stopDrawing}
                      onMouseLeave={stopDrawing}
                    />
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 text-slate-600">
                  <Sparkles className="h-12 w-12 stroke-[1.5]" />
                  <p className="text-sm font-medium">Select an asset from the library or create a new one.</p>
                </div>
              )}
            </div>

            {/* Bottom Active Version Pill */}
            {activeVersion && (
              <div className="absolute bottom-4 z-20 flex items-center gap-3 rounded-full border border-slate-800 bg-slate-900/90 px-4 py-1.5 text-xs text-slate-300 backdrop-blur shadow-lg">
                <span className="font-semibold text-indigo-400">{activeVersion.versionId}</span>
                <span>•</span>
                <span className="truncate max-w-xs">{activeVersion.changeDescription}</span>
                {activeVersion.fps && (
                  <>
                    <span>•</span>
                    <span className="text-indigo-300 font-medium">{activeVersion.fps} FPS</span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ─── Right Sidebar: Controls, Revisions, Animations & Cast ───────── */}
          <div className="flex w-96 flex-col border-l border-slate-800 bg-slate-900/60 overflow-y-auto">
            {mode === 'entities' ? (
              /* ─── Phase 3: Cast & Props Roster ──────────────────────────────── */
              <div className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-200">Cast & Props Roster</h2>
                    <p className="text-xs text-slate-400 mt-0.5">Recurring characters & items locked across scenes.</p>
                  </div>
                  <button
                    onClick={() => setShowNewEntityModal(true)}
                    className="flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white shadow hover:bg-indigo-500 transition"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    New
                  </button>
                </div>

                {/* Entity List */}
                <div className="space-y-3">
                  {entities.map((ent) => (
                    <div
                      key={ent.id}
                      className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="h-8 w-8 rounded-full overflow-hidden border border-slate-700 bg-slate-900">
                            {ent.referenceImages[0] ? (
                              <img src={ent.referenceImages[0].imageUrl} alt={ent.name} className="h-full w-full object-cover" />
                            ) : (
                              <Users className="h-4 w-4 m-2 text-slate-500" />
                            )}
                          </div>
                          <div>
                            <h3 className="text-xs font-semibold text-slate-200">{ent.name}</h3>
                            <span className="rounded bg-indigo-950 px-1.5 py-0.2 text-[10px] font-medium text-indigo-300 border border-indigo-800/50">
                              {ent.category}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            setSelectedEntityId(selectedEntityId === ent.id ? '' : ent.id);
                            setMode('create');
                          }}
                          className={`rounded px-2 py-0.5 text-xs font-medium transition ${
                            selectedEntityId === ent.id
                              ? 'bg-emerald-600 text-white'
                              : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                          }`}
                        >
                          {selectedEntityId === ent.id ? 'Attached' : 'Use in Scene'}
                        </button>
                      </div>

                      {ent.description && <p className="text-[11px] text-slate-400">{ent.description}</p>}
                      {ent.triggerWord && (
                        <div className="text-[10px] text-slate-500">
                          Trigger: <code className="text-indigo-300">{ent.triggerWord}</code>
                        </div>
                      )}
                    </div>
                  ))}
                  {entities.length === 0 && (
                    <div className="py-8 text-center text-xs text-slate-500">
                      No characters or props saved yet.<br />Generate a character and click "Save as Character" above.
                    </div>
                  )}
                </div>
              </div>
            ) : mode === 'create' ? (
              /* ─── Create Form ──────────────────────────────────────────────── */
              <div className="p-4 space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">Create New Asset</h2>
                  <p className="text-xs text-slate-400 mt-0.5">Generate a high-fidelity image from a text prompt.</p>
                </div>

                {/* Character Reference Attachment */}
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Attach Character / Prop (IP-Adapter)
                  </label>
                  <select
                    value={selectedEntityId}
                    onChange={(e) => setSelectedEntityId(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="">None (Standard Generation)</option>
                    {entities.map((ent) => (
                      <option key={ent.id} value={ent.id}>
                        {ent.name} ({ent.category}) {ent.referenceImages.length > 0 ? '✓' : '(No Image)'}
                      </option>
                    ))}
                  </select>

                  {selectedEntityId && (
                    <div className="mt-2 space-y-1">
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>Identity Lock Weight</span>
                        <span className="text-indigo-400">{entityWeight.toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min="0.2"
                        max="1.0"
                        step="0.05"
                        value={entityWeight}
                        onChange={(e) => setEntityWeight(Number(e.target.value))}
                        className="w-full h-1 bg-slate-800 rounded cursor-pointer accent-indigo-500"
                      />
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Prompt</label>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. A vintage red sports car parked in front of a modern neon diner at night"
                    className="w-full h-24 rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Negative Prompt</label>
                  <input
                    type="text"
                    value={negativePrompt}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                    placeholder="e.g. blurry, distorted, bad anatomy, text"
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Style Preset</label>
                  <select
                    value={stylePreset}
                    onChange={(e) => setStylePreset(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="photorealistic">Photorealistic PBR (1024×1024)</option>
                    <option value="cinematic">Cinematic 35mm Film</option>
                    <option value="digital_art">Digital Concept Art</option>
                    <option value="anime">Anime / Stylized Illustration</option>
                  </select>
                </div>

                <button
                  onClick={handleGenerate}
                  disabled={!prompt.trim() || generating}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-500 disabled:opacity-50 transition"
                >
                  {generating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {generating ? 'Generating Asset...' : selectedEntityId ? 'Generate with Character Lock' : 'Generate Asset'}
                </button>
              </div>
            ) : mode === 'animate' ? (
              /* ─── Phase 2: Animate (Image-to-Video) Form ───────────────────────── */
              <div className="p-4 space-y-4">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">Animate Version (I2V)</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Generate continuous temporal motion from the selected image still.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Camera & Motion Prompt</label>
                  <textarea
                    value={animationPrompt}
                    onChange={(e) => setAnimationPrompt(e.target.value)}
                    placeholder="e.g. cinematic camera slow pan right, wheels spinning smoothly, headlights illuminating road"
                    className="w-full h-20 rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Video Model</label>
                  <select
                    value={videoModel}
                    onChange={(e) => setVideoModel(e.target.value as any)}
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="ltx-video">LTX-Video 2B Distilled (Primary Fast I2V, ~25s)</option>
                    <option value="wan2.1-1.3b">Wan 2.1 1.3B (Motion Quality Tier, ~60s)</option>
                  </select>
                </div>

                <button
                  onClick={handleAnimate}
                  disabled={animating || !selectedAsset}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-500 disabled:opacity-50 transition"
                >
                  {animating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
                  {animating ? 'Rendering Video Animation...' : 'Render Animation (I2V)'}
                </button>

                {/* Version History */}
                <div className="border-t border-slate-800 pt-4">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Version History</span>
                    <span className="text-xs text-slate-500">{selectedAsset?.versions.length} versions</span>
                  </div>

                  <div className="space-y-2">
                    {selectedAsset?.versions.map((ver) => {
                      const isActive = ver.versionId === activeVersionId;
                      const isAnim = ver.operationType === 'animate';
                      return (
                        <div
                          key={ver.versionId}
                          onClick={() => setActiveVersionId(ver.versionId)}
                          className={`flex cursor-pointer items-center justify-between rounded-lg border p-2.5 transition ${
                            isActive
                              ? 'border-indigo-500/80 bg-indigo-950/30'
                              : 'border-slate-800/80 bg-slate-950 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            {isAnim ? (
                              <Film className={`h-3.5 w-3.5 ${isActive ? 'text-indigo-400' : 'text-slate-500'}`} />
                            ) : (
                              <span className={`text-xs font-bold ${isActive ? 'text-indigo-400' : 'text-slate-500'}`}>
                                {ver.versionId}
                              </span>
                            )}
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium text-slate-200">{ver.changeDescription}</p>
                              <span className="text-[10px] text-slate-500">{ver.operationType}</span>
                            </div>
                          </div>

                          {!isActive && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleRevert(ver.versionId);
                              }}
                              className="text-[11px] font-medium text-slate-400 hover:text-indigo-400 px-1.5 py-0.5 rounded bg-slate-800/80"
                            >
                              Revert
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              /* ─── Revise Form (Targeted Edit & Lineage) ───────────────────────── */
              <div className="p-4 space-y-5">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">Targeted Revision</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Preserve everything; change only what was requested.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Revision Request</label>
                  <input
                    type="text"
                    value={revisionPrompt}
                    onChange={(e) => setRevisionPrompt(e.target.value)}
                    placeholder="e.g. Make the car red, or add a sword to his hand"
                    className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">Edit Scope</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => { setEditScope('localized'); setDenoise(0.85); }}
                      className={`rounded-lg border p-2 text-left transition ${
                        editScope === 'localized'
                          ? 'border-indigo-500 bg-indigo-950/40 text-white'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-xs font-semibold">Localized Inpaint</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">Mask-bounded surgical edit</div>
                    </button>
                    <button
                      onClick={() => { setEditScope('structural'); setDenoise(0.45); }}
                      className={`rounded-lg border p-2 text-left transition ${
                        editScope === 'structural'
                          ? 'border-indigo-500 bg-indigo-950/40 text-white'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-xs font-semibold">Structural Img2Img</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">Locked composition & pose</div>
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-300 mb-1">
                    <span>Denoising Strength</span>
                    <span className="text-indigo-400">{denoise.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0.10"
                    max="0.95"
                    step="0.05"
                    value={denoise}
                    onChange={(e) => setDenoise(Number(e.target.value))}
                    className="w-full h-1.5 bg-slate-800 rounded cursor-pointer accent-indigo-500"
                  />
                </div>

                <button
                  onClick={handleRevise}
                  disabled={!revisionPrompt.trim() || revising}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-500 disabled:opacity-50 transition"
                >
                  {revising ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  {revising ? 'Applying Targeted Revision...' : 'Apply Revision (Non-Destructive)'}
                </button>

                {/* ─── Version History DAG ────────────────────────────────────── */}
                <div className="border-t border-slate-800 pt-4">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Version History</span>
                    <span className="text-xs text-slate-500">{selectedAsset?.versions.length} versions</span>
                  </div>

                  <div className="space-y-2">
                    {selectedAsset?.versions.map((ver) => {
                      const isActive = ver.versionId === activeVersionId;
                      const isAnim = ver.operationType === 'animate';
                      return (
                        <div
                          key={ver.versionId}
                          onClick={() => setActiveVersionId(ver.versionId)}
                          className={`flex cursor-pointer items-center justify-between rounded-lg border p-2.5 transition ${
                            isActive
                              ? 'border-indigo-500/80 bg-indigo-950/30'
                              : 'border-slate-800/80 bg-slate-950 hover:border-slate-700'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            {isAnim ? (
                              <Film className={`h-3.5 w-3.5 ${isActive ? 'text-indigo-400' : 'text-slate-500'}`} />
                            ) : (
                              <span className={`text-xs font-bold ${isActive ? 'text-indigo-400' : 'text-slate-500'}`}>
                                {ver.versionId}
                              </span>
                            )}
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium text-slate-200">{ver.changeDescription}</p>
                              <span className="text-[10px] text-slate-500">{ver.operationType}</span>
                            </div>
                          </div>

                          {!isActive && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleRevert(ver.versionId);
                              }}
                              className="text-[11px] font-medium text-slate-400 hover:text-indigo-400 px-1.5 py-0.5 rounded bg-slate-800/80"
                            >
                              Revert
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ─── Gemma 12B Vision Quality & Drift Review ───────────────── */}
                <div className="border-t border-slate-800 pt-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Gemma Vision QA</span>
                    <button
                      onClick={triggerCreationReview}
                      disabled={reviewing}
                      className="text-[11px] font-medium text-indigo-400 hover:text-indigo-300 flex items-center gap-1 disabled:opacity-50"
                    >
                      {reviewing ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
                      Inspect Version
                    </button>
                  </div>

                  {activeVersion?.review ? (
                    <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-300">Overall Score</span>
                        <span className={`rounded px-2 py-0.5 font-bold ${
                          activeVersion.review.score >= 70 ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-amber-950 text-amber-300 border border-amber-800'
                        }`}>
                          {activeVersion.review.score}/100 ({activeVersion.review.verdict.toUpperCase()})
                        </span>
                      </div>

                      <p className="text-slate-400 text-xs leading-relaxed">{activeVersion.review.critique}</p>

                      {activeVersion.review.revisionMetrics && (
                        <div className="space-y-1.5 pt-2 border-t border-slate-900">
                          <div className="flex justify-between text-[11px] text-slate-400">
                            <span>Change Success</span>
                            <span className="text-slate-200">{activeVersion.review.revisionMetrics.requestedChangeSuccess}%</span>
                          </div>
                          <div className="flex justify-between text-[11px] text-slate-400">
                            <span>Identity Lock</span>
                            <span className="text-slate-200">{activeVersion.review.revisionMetrics.identityPreservation}%</span>
                          </div>
                          <div className="flex justify-between text-[11px] text-slate-400">
                            <span>Composition Lock</span>
                            <span className="text-slate-200">{activeVersion.review.revisionMetrics.compositionPreservation}%</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-800 p-3 text-center text-xs text-slate-500">
                      No visual review performed on this version yet.<br />Click Inspect Version to run Gemma QA.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Modal: Add Shot to Storyboard (Phase 4) ───────────────────────── */}
      {showAddShotModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-2xl space-y-4">
            <h2 className="text-sm font-semibold text-white">Add Shot to Sequence</h2>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Visual Prompt</label>
              <textarea
                value={newShotPrompt}
                onChange={(e) => setNewShotPrompt(e.target.value)}
                placeholder="e.g. Captain Marcus looks up at the towering neon skybridge as flying vehicles streak past"
                className="w-full h-20 rounded-lg border border-slate-800 bg-slate-950 p-2.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Shot Type</label>
                <select
                  value={newShotType}
                  onChange={(e) => setNewShotType(e.target.value as any)}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                >
                  <option value="establishing">Establishing Shot</option>
                  <option value="wide">Wide Shot</option>
                  <option value="medium">Medium Shot</option>
                  <option value="close_up">Close-Up Shot</option>
                  <option value="over_the_shoulder">Over the Shoulder</option>
                  <option value="action">Action / Tracking</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Camera Movement</label>
                <select
                  value={newShotCamera}
                  onChange={(e) => setNewShotCamera(e.target.value as any)}
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                >
                  <option value="static">Static Locked Off</option>
                  <option value="pan_right">Pan Right</option>
                  <option value="pan_left">Pan Left</option>
                  <option value="tilt_up">Tilt Up</option>
                  <option value="tilt_down">Tilt Down</option>
                  <option value="zoom_in">Slow Zoom In</option>
                  <option value="zoom_out">Slow Zoom Out</option>
                  <option value="tracking">Forward Tracking</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Character / Prop Lock (Optional)</label>
              <select
                value={newShotEntityId}
                onChange={(e) => setNewShotEntityId(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="">None (Generic Subject)</option>
                {entities.map((ent) => (
                  <option key={ent.id} value={ent.id}>
                    {ent.name} ({ent.category})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowAddShotModal(false)}
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={handleAddShot}
                disabled={!newShotPrompt.trim()}
                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow hover:bg-indigo-500 disabled:opacity-50"
              >
                Add to Sequence
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: New Custom Entity (Phase 3) ─────────────────────────────── */}
      {showNewEntityModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-2xl space-y-4">
            <h2 className="text-sm font-semibold text-white">Add Entity to Cast & Props Roster</h2>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Name</label>
              <input
                type="text"
                value={newEntityName}
                onChange={(e) => setNewEntityName(e.target.value)}
                placeholder="e.g. Captain Marcus, Cyberpunk Hovercar"
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Category</label>
              <select
                value={newEntityCategory}
                onChange={(e) => setNewEntityCategory(e.target.value as any)}
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="character">Character</option>
                <option value="vehicle">Vehicle</option>
                <option value="prop">Prop</option>
                <option value="environment">Environment / Location</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Trigger Word (Optional)</label>
              <input
                type="text"
                value={newEntityTrigger}
                onChange={(e) => setNewEntityTrigger(e.target.value)}
                placeholder="e.g. cmarcus_man, neon_hovercar_99"
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Description</label>
              <textarea
                value={newEntityDesc}
                onChange={(e) => setNewEntityDesc(e.target.value)}
                placeholder="Distinct visual traits, clothing, hair color, markings..."
                className="w-full h-20 rounded-lg border border-slate-800 bg-slate-950 p-2.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowNewEntityModal(false)}
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateEntity}
                disabled={!newEntityName.trim()}
                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow hover:bg-indigo-500 disabled:opacity-50"
              >
                Save Entity
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
