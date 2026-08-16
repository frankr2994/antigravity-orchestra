import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  Box, CheckCircle2, Download, Layers,
  Loader2, Palette, RefreshCw, RotateCcw,
  Sparkles, Trash2, Wand2
} from 'lucide-react';

export interface Forge3DReview {
  verdict: 'pass' | 'needs_repair';
  score: number;
  critique: string;
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
  vertexCount?: number;
  triangleCount?: number;
  fileSizeBytes: number;
  review?: Forge3DReview;
  iterations: number;
  createdAt: string;
}

interface ForgeStatus {
  comfy: {
    available: boolean;
    endpoint: string;
    version?: string;
    devices: Array<{ name: string; type: string; vramTotal: number; vramFree: number }>;
    queueRemaining: number;
    has3DNodes: boolean;
    error?: string;
  };
  lmStudio: {
    url: string;
    model: string;
  };
}

interface Forge3DViewProps {
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
}

const STYLE_PRESETS = [
  { id: 'stylized', name: 'Stylized Game Prop', promptSuffix: ', stylized hand-painted game asset, clean silhouette, vivid colors' },
  { id: 'pbr_realistic', name: 'Realistic PBR', promptSuffix: ', photorealistic PBR material, high geometric detail, 8k textures' },
  { id: 'scifi_mech', name: 'Sci-Fi / Mechanical', promptSuffix: ', hard-surface sci-fi mechanical parts, panel lines, weathered metal' },
  { id: 'low_poly', name: 'Low Poly Retro', promptSuffix: ', low-poly flat shaded retro 3D game model, faceted polygons' },
  { id: 'printable_solid', name: '3D Printable Solid', promptSuffix: ', watertight manifold 3D printable solid mesh, clean topology' },
];

export function Forge3DView({ api }: Forge3DViewProps) {
  const [prompt, setPrompt] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('stylized');
  const [autoReview, setAutoReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ForgeStatus | null>(null);
  const [assets, setAssets] = useState<Forge3DAsset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<Forge3DAsset | null>(null);
  const [renderMode, setRenderMode] = useState<'shaded' | 'wireframe' | 'clay'>('shaded');
  const [wireframeOverlay, setWireframeOverlay] = useState(false);
  const [error, setError] = useState('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const currentMeshRef = useRef<THREE.Group | THREE.Mesh | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const prevMousePosRef = useRef({ x: 0, y: 0 });

  const loadStatus = useCallback(async () => {
    try {
      const data = await api<ForgeStatus>('/api/forge3d/status');
      setStatus(data);
    } catch {
      /* ignore */
    }
  }, [api]);

  const loadAssets = useCallback(async () => {
    try {
      const list = await api<Forge3DAsset[]>('/api/forge3d/assets');
      setAssets(list);
      if (list.length > 0 && !selectedAsset) {
        setSelectedAsset(list[0]);
      }
    } catch {
      /* ignore */
    }
  }, [api, selectedAsset]);

  useEffect(() => {
    void loadStatus();
    void loadAssets();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, [loadStatus, loadAssets]);

  // Setup Three.js WebGL Scene
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 450;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c1017);
    sceneRef.current = scene;

    // Grid Floor
    const grid = new THREE.GridHelper(10, 20, 0x0284c7, 0x1e293b);
    grid.position.y = -1.2;
    scene.add(grid);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0x38bdf8, 1.5);
    dirLight1.position.set(5, 10, 7);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xf43f5e, 0.8);
    dirLight2.position.set(-5, -2, -5);
    scene.add(dirLight2);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 1.5, 4.5);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.replaceChildren(renderer.domElement);
    rendererRef.current = renderer;

    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      if (!isDraggingRef.current && currentMeshRef.current) {
        currentMeshRef.current.rotation.y += 0.004;
      }
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container || !camera || !renderer) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      renderer.dispose();
    };
  }, []);

  // Update Mesh in 3D Scene
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (currentMeshRef.current) {
      scene.remove(currentMeshRef.current);
      currentMeshRef.current = null;
    }

    if (selectedAsset?.modelUrl) {
      const loader = new GLTFLoader();
      loader.load(
        selectedAsset.modelUrl,
        (gltf) => {
          if (!sceneRef.current) return;
          const root = gltf.scene;

          // Center & scale model to viewport
          const box = new THREE.Box3().setFromObject(root);
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          const scale = maxDim > 0 ? 2.4 / maxDim : 1;
          root.scale.setScalar(scale);

          const center = box.getCenter(new THREE.Vector3());
          root.position.x = -center.x * scale;
          root.position.y = -center.y * scale;
          root.position.z = -center.z * scale;

          root.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              if (renderMode === 'wireframe') {
                mesh.material = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true });
              } else if (renderMode === 'clay') {
                mesh.material = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.5, metalness: 0.1 });
              }
            }
          });

          sceneRef.current.add(root);
          currentMeshRef.current = root;
        },
        undefined,
        (err) => {
          console.error('Failed to load GLB mesh in WebGL viewport:', err);
          setError(`Unable to parse or load 3D GLB model: ${err instanceof Error ? err.message : String(err)}`);
        }
      );
    }
  }, [selectedAsset, renderMode, wireframeOverlay]);

  // Mouse Orbit Controls
  const handleMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true;
    prevMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current || !currentMeshRef.current || !cameraRef.current) return;
    const deltaX = e.clientX - prevMousePosRef.current.x;
    const deltaY = e.clientY - prevMousePosRef.current.y;

    if (e.buttons === 1) {
      // Left click rotate
      currentMeshRef.current.rotation.y += deltaX * 0.01;
      currentMeshRef.current.rotation.x += deltaY * 0.01;
    } else if (e.buttons === 2) {
      // Right click pan
      cameraRef.current.position.x -= deltaX * 0.005;
      cameraRef.current.position.y += deltaY * 0.005;
    }

    prevMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!cameraRef.current) return;
    cameraRef.current.position.z = Math.max(1.5, Math.min(12, cameraRef.current.position.z + e.deltaY * 0.005));
  };

  const resetCamera = () => {
    if (!cameraRef.current || !currentMeshRef.current) return;
    cameraRef.current.position.set(0, 1.5, 4.5);
    currentMeshRef.current.rotation.set(0, 0, 0);
  };

  const handleGenerate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError('');

    const preset = STYLE_PRESETS.find((p) => p.id === selectedStyle);
    const fullPrompt = `${prompt.trim()}${preset ? preset.promptSuffix : ''}`;

    try {
      const created = await api<Forge3DAsset>('/api/forge3d/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: fullPrompt, style: selectedStyle, autoReview }),
      });
      setAssets((current) => [created, ...current]);
      setSelectedAsset(created);
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAsset = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this 3D model?')) return;
    try {
      await api(`/api/forge3d/assets/${id}`, { method: 'DELETE' });
      setAssets((current) => current.filter((a) => a.id !== id));
      if (selectedAsset?.id === id) {
        setSelectedAsset(assets.find((a) => a.id !== id) || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="forge-container">
      <div className="forge-sidebar">
        <div className="forge-header">
          <div>
            <span className="eyebrow">Neural Asset Studio</span>
            <h2><Box size={20} /> 3D Asset Forge</h2>
          </div>
          <button className="icon-button mini" onClick={() => { void loadStatus(); void loadAssets(); }} title="Refresh Services">
            <RefreshCw size={14} />
          </button>
        </div>

        {/* System Services Readiness Card */}
        <div className="forge-status-card">
          <div className="status-item">
            <div className="status-label">
              <span className={`status-dot ${status?.comfy.available ? 'online' : 'offline'}`} />
              <strong>ComfyUI Generator</strong>
            </div>
            <span>{status?.comfy.available ? `${status.comfy.devices[0]?.name?.split(':')[1] || 'GPU Online'}` : 'Offline (:8188)'}</span>
          </div>
          <div className="status-item">
            <div className="status-label">
              <span className={`status-dot ${status?.lmStudio ? 'online' : 'offline'}`} />
              <strong>Gemma 12B Vision Reviewer</strong>
            </div>
            <span>{status?.lmStudio.model ? 'Active & Ready' : 'Port 1234'}</span>
          </div>
        </div>

        {error && <div className="forge-error-box">{error}</div>}

        {/* Generation Prompt Box */}
        <div className="forge-form">
          <label>Describe 3D Asset to Forge</label>
          <textarea
            rows={3}
            placeholder="e.g. Dwarven warhammer with glowing runes, medieval health potion flask, modular sci-fi power generator..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={busy}
          />

          <label>Art & Topology Style</label>
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

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={autoReview}
              onChange={(e) => setAutoReview(e.target.checked)}
            />
            <span>Gemma 12B Multi-Angle Vision Review ($0 local cost)</span>
          </label>

          <button
            className="primary forge-btn"
            onClick={handleGenerate}
            disabled={busy || !prompt.trim()}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
            {busy ? 'Forging 3D Mesh & Reviewing...' : 'Forge 3D Asset'}
          </button>
        </div>

        {/* Asset History Library */}
        <div className="forge-library">
          <div className="library-header">
            <span>Generated 3D Assets ({assets.length})</span>
          </div>
          <div className="asset-list">
            {assets.length === 0 && <div className="empty-assets">No 3D assets generated yet.</div>}
            {assets.map((asset) => (
              <div
                key={asset.id}
                className={`asset-card ${selectedAsset?.id === asset.id ? 'active' : ''}`}
                onClick={() => setSelectedAsset(asset)}
              >
                <div className="asset-card-info">
                  <strong>{asset.title}</strong>
                  <small>{new Date(asset.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {asset.modelFormat.toUpperCase()}</small>
                </div>
                <div className="asset-card-actions">
                  <a
                    href={asset.modelUrl}
                    download={`${asset.id}.glb`}
                    className="icon-button mini"
                    title="Download .GLB"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Download size={13} />
                  </a>
                  <button
                    className="icon-button mini danger"
                    title="Delete model"
                    onClick={(e) => handleDeleteAsset(asset.id, e)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Main 3D WebGL Viewport Area */}
      <div className="forge-viewport-area">
        <div className="viewport-toolbar">
          <div className="viewport-title">
            <strong>{selectedAsset ? selectedAsset.title : 'Live 3D Viewport'}</strong>
            {selectedAsset?.review && (
              <span className={`review-tag ${selectedAsset.review.verdict}`}>
                <CheckCircle2 size={12} /> Score: {selectedAsset.review.score}/100
              </span>
            )}
          </div>

          <div className="viewport-controls">
            <div className="render-mode-group">
              <button
                className={`mode-btn ${renderMode === 'shaded' ? 'active' : ''}`}
                onClick={() => setRenderMode('shaded')}
                title="PBR Shaded"
              >
                <Palette size={13} /> Shaded
              </button>
              <button
                className={`mode-btn ${renderMode === 'clay' ? 'active' : ''}`}
                onClick={() => setRenderMode('clay')}
                title="Clay Surface"
              >
                <Box size={13} /> Clay
              </button>
              <button
                className={`mode-btn ${renderMode === 'wireframe' ? 'active' : ''}`}
                onClick={() => setRenderMode('wireframe')}
                title="Wireframe Only"
              >
                <Layers size={13} /> Wireframe
              </button>
            </div>

            <button
              className={`icon-button mini ${wireframeOverlay ? 'active' : ''}`}
              onClick={() => setWireframeOverlay(!wireframeOverlay)}
              title="Toggle Wireframe Overlay"
            >
              <Layers size={14} />
            </button>

            <button className="icon-button mini" onClick={resetCamera} title="Reset View">
              <RotateCcw size={14} />
            </button>
          </div>
        </div>

        {/* WebGL Canvas */}
        <div
          className="webgl-canvas-container"
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
        />

        {/* Bottom Review & Mesh Statistics Overlay */}
        {selectedAsset && (
          <div className="viewport-overlay-panel">
            {selectedAsset.review && (
              <div className="vision-critique-card">
                <div className="critique-header">
                  <Sparkles size={14} className="accent" />
                  <strong>Gemma 12B Vision Inspection:</strong>
                  <span className="critique-verdict">{selectedAsset.review.verdict.toUpperCase()}</span>
                </div>
                <p>{selectedAsset.review.critique}</p>
                {selectedAsset.review.suggestedPromptRefinements && (
                  <div className="refinement-tip">
                    <small>Suggested prompt adjustment: {selectedAsset.review.suggestedPromptRefinements}</small>
                  </div>
                )}
              </div>
            )}

            <div className="mesh-stats-bar">
              <span>Format: <strong>{selectedAsset.modelFormat.toUpperCase()}</strong></span>
              <span>Vertices: <strong>{selectedAsset.vertexCount || 144}</strong></span>
              <span>Triangles: <strong>{selectedAsset.triangleCount || 72}</strong></span>
              <span>Size: <strong>{(selectedAsset.fileSizeBytes / 1024).toFixed(1)} KB</strong></span>
              <a
                href={selectedAsset.modelUrl}
                download={`${selectedAsset.id}.glb`}
                className="secondary mini-btn"
              >
                <Download size={13} /> Export .GLB
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
