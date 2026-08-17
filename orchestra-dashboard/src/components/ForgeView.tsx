import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Eye,
  Film,
  Paintbrush,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  EditScope,
  ForgeAsset,
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

  // Mode: Create | Revise | Animate
  const [mode, setMode] = useState<'create' | 'revise' | 'animate'>('create');

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

  // 1. Fetch Engine Status & Assets
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

  useEffect(() => {
    void fetchStatus();
    void fetchAssets();
    const timer = setInterval(() => {
      void fetchStatus();
    }, 10000);
    return () => clearInterval(timer);
  }, [fetchStatus, fetchAssets]);

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

  // 3. New Generation Handler
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

  // 5. Video Animation Handler (Phase 2 Image-to-Video)
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

  // 6. Version Revert Handler
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

  // 7. Gemma 12B Vision Review
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

  // 8. Canvas Mask Drawing Helpers
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
            <h1 className="text-base font-semibold tracking-wide text-white">Forge Studio (2D & Video)</h1>
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

      {/* ─── Main Workspace Layout ────────────────────────────────────────── */}
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

        {/* ─── Right Sidebar: Controls, Revisions & Animations ───────────────── */}
        <div className="flex w-96 flex-col border-l border-slate-800 bg-slate-900/60 overflow-y-auto">
          {mode === 'create' ? (
            /* ─── Create Form ──────────────────────────────────────────────── */
            <div className="p-4 space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-200">Create New Asset</h2>
                <p className="text-xs text-slate-400 mt-0.5">Generate a high-fidelity image from a text prompt.</p>
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
                {generating ? 'Generating Asset...' : 'Generate Asset'}
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
    </div>
  );
};
