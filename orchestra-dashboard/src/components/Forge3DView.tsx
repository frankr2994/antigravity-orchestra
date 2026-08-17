import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  AlertTriangle, Box, CheckCircle2, Download, HardDriveDownload, Image as ImageIcon,
  Layers, Loader2, Palette, RefreshCw, RotateCcw,
  Sparkles, Trash2, Upload, Wand2, Wrench, X
} from 'lucide-react';

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
  mode?: 'text_to_3d' | 'image_to_3d';
  modelFormat: 'glb' | 'obj' | 'stl';
  modelPath: string;
  modelUrl: string;
  previewUrl?: string;
  vertexCount: number;
  triangleCount: number;
  isWatertight?: boolean;
  surfaceArea?: number;
  eulerNumber?: number;
  boundingBox?: { min: [number, number, number]; max: [number, number, number]; extents: [number, number, number] };
  fileSizeBytes: number;
  review?: Forge3DReview;
  iterations: number;
  createdAt: string;
}

interface DependencyStatus {
  id: string;
  name: string;
  category: 'model' | 'node' | 'python_pkg';
  targetSubdir: string;
  fileName: string;
  sizeBytes: number;
  description: string;
  required: boolean;
  installed: boolean;
  actualSizeBytes?: number;
  localPath: string;
}

interface ForgeSetupStatus {
  comfyFound: boolean;
  comfyPath: string | null;
  comfyRunning: boolean;
  readyFor3D: boolean;
  restartRequired: boolean;
  items: DependencyStatus[];
  missingCount: number;
  missingBytes: number;
}

interface ActiveDownloadProgress {
  depId: string;
  fileName: string;
  bytesReceived: number;
  totalBytes: number;
  percent: number;
  speedBytesPerSec: number;
  status: 'downloading' | 'verifying' | 'completed' | 'error';
  error?: string;
}

interface ForgeStatus {
  comfy: {
    available: boolean;
    endpoint: string;
    version?: string;
    devices: Array<{ name: string; type: string; vramTotal: number; vramFree: number }>;
    queueRemaining: number;
    has3DNodes: boolean;
    tripoReady: boolean;
    error?: string;
  };
  lmStudio: {
    url: string;
    model: string;
    available?: boolean;
    isMultimodal?: boolean;
    error?: string;
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
  const [inputMode, setInputMode] = useState<'text_to_3d' | 'image_to_3d'>('text_to_3d');
  const [prompt, setPrompt] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('stylized');
  const [autoReview, setAutoReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [status, setStatus] = useState<ForgeStatus | null>(null);
  const [setupStatus, setSetupStatus] = useState<ForgeSetupStatus | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<ActiveDownloadProgress | null>(null);
  const [assets, setAssets] = useState<Forge3DAsset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<Forge3DAsset | null>(null);
  const [renderMode, setRenderMode] = useState<'shaded' | 'wireframe' | 'clay'>('shaded');
  const [wireframeOverlay, setWireframeOverlay] = useState(false);
  const [error, setError] = useState('');
  const [installingDepId, setInstallingDepId] = useState<string | null>(null);

  // Direct Image Upload State
  const [uploadedImageBase64, setUploadedImageBase64] = useState<string | null>(null);
  const [uploadedImageName, setUploadedImageName] = useState<string>('');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const currentMeshRef = useRef<THREE.Group | THREE.Mesh | null>(null);
  const diagnosticLightsRef = useRef<THREE.Group | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const prevMousePosRef = useRef({ x: 0, y: 0 });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const reviewedAttemptsRef = useRef<Set<string>>(new Set());

  const loadStatus = useCallback(async () => {
    try {
      const data = await api<ForgeStatus>('/api/forge3d/status');
      setStatus(data);
    } catch {
      /* ignore */
    }
  }, [api]);

  const loadSetupStatus = useCallback(async () => {
    try {
      const setup = await api<ForgeSetupStatus>('/api/forge3d/setup/status');
      setSetupStatus(setup);
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

  const pollDownload = useCallback(async () => {
    try {
      const data = await api<{ progress: ActiveDownloadProgress | null }>('/api/forge3d/setup/progress');
      setDownloadProgress(data.progress);
      if (data.progress?.status === 'completed' || data.progress?.status === 'error') {
        void loadSetupStatus();
        void loadStatus();
        if (data.progress.status === 'completed') {
          setInstallingDepId(null);
        }
      }
    } catch {
      /* ignore */
    }
  }, [api, loadSetupStatus, loadStatus]);

  useEffect(() => {
    void loadStatus();
    void loadSetupStatus();
    void loadAssets();
    const interval = setInterval(() => {
      void loadStatus();
      void loadSetupStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadStatus, loadSetupStatus, loadAssets]);

  useEffect(() => {
    if (installingDepId || (downloadProgress && downloadProgress.status === 'downloading')) {
      const progressInterval = setInterval(pollDownload, 1000);
      return () => clearInterval(progressInterval);
    }
  }, [installingDepId, downloadProgress, pollDownload]);

  // Capture 6 Standardized Deterministic Diagnostic Snapshots with Dedicated White 3-Point Lighting
  const captureSnapshots = useCallback(async (): Promise<string[]> => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const mesh = currentMeshRef.current;
    if (!renderer || !scene || !camera || !mesh) return [];

    // 1. Save interactive viewport state
    const origRotX = mesh.rotation.x;
    const origRotY = mesh.rotation.y;
    const origRotZ = mesh.rotation.z;
    const origCamPos = camera.position.clone();
    const origBg = scene.background;

    // 2. Hide interactive colored viewport lights
    const interactiveLights: THREE.Light[] = [];
    scene.traverse((child) => {
      if ((child as THREE.Light).isLight) {
        interactiveLights.push(child as THREE.Light);
        (child as THREE.Light).visible = false;
      }
    });

    // 3. Set neutral 50% gray diagnostic background & hide grid
    scene.background = new THREE.Color(0x808080);
    const gridChild = scene.children.find((c) => c instanceof THREE.GridHelper);
    if (gridChild) gridChild.visible = false;

    // 4. Create dedicated pure white 3-point diagnostic lighting setup
    const diagKeyLight = new THREE.DirectionalLight(0xffffff, 1.3);
    diagKeyLight.position.set(4, 5, 5);
    scene.add(diagKeyLight);

    const diagFillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    diagFillLight.position.set(-5, 2, 4);
    scene.add(diagFillLight);

    const diagRimLight = new THREE.DirectionalLight(0xffffff, 0.8);
    diagRimLight.position.set(0, -3, -5);
    scene.add(diagRimLight);

    const diagAmbientLight = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(diagAmbientLight);

    // 5. Cache original mesh materials
    const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const m = child as THREE.Mesh;
        originalMaterials.set(m, m.material);
      }
    });

    const clayMaterial = new THREE.MeshStandardMaterial({
      color: 0xb0b0b0,
      roughness: 0.45,
      metalness: 0.05,
    });
    const wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x0284c7,
      wireframe: true,
    });

    const snapshots: string[] = [];
    camera.position.set(0, 1.0, 3.8);
    camera.lookAt(0, 0, 0);

    // Pass 1: Front Shaded (0°)
    mesh.rotation.set(0, 0, 0);
    renderer.render(scene, camera);
    snapshots.push(renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));

    // Pass 2: 3/4 Iso Shaded (45°)
    mesh.rotation.set(0.12, Math.PI / 4, 0);
    renderer.render(scene, camera);
    snapshots.push(renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));

    // Pass 3: Side Profile Shaded (90°)
    mesh.rotation.set(0, Math.PI / 2, 0);
    renderer.render(scene, camera);
    snapshots.push(renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));

    // Pass 4: Rear Shaded (180°)
    mesh.rotation.set(0, Math.PI, 0);
    renderer.render(scene, camera);
    snapshots.push(renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));

    // Pass 5: 3/4 Iso Clay Surface (45°)
    mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = clayMaterial;
    });
    mesh.rotation.set(0.12, Math.PI / 4, 0);
    renderer.render(scene, camera);
    snapshots.push(renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));

    // Pass 6: 3/4 Iso Wireframe (45°)
    mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = wireMaterial;
    });
    renderer.render(scene, camera);
    snapshots.push(renderer.domElement.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''));

    // 6. Clean up diagnostic lights
    scene.remove(diagKeyLight);
    scene.remove(diagFillLight);
    scene.remove(diagRimLight);
    scene.remove(diagAmbientLight);
    diagKeyLight.dispose();
    diagFillLight.dispose();
    diagRimLight.dispose();
    diagAmbientLight.dispose();

    // 7. Restore interactive viewport state
    mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const m = child as THREE.Mesh;
        const orig = originalMaterials.get(m);
        if (orig) m.material = orig;
      }
    });
    interactiveLights.forEach((l) => { l.visible = true; });
    scene.background = origBg;
    if (gridChild) gridChild.visible = true;
    mesh.rotation.set(origRotX, origRotY, origRotZ);
    camera.position.copy(origCamPos);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);

    return snapshots;
  }, []);

  const triggerVisualReview = useCallback(async (targetAsset: Forge3DAsset) => {
    if (!targetAsset || reviewing) return;
    reviewedAttemptsRef.current.add(targetAsset.id);
    try {
      setReviewing(true);
      setError('');
      await new Promise((r) => setTimeout(r, 200));
      const snapshots = await captureSnapshots();
      if (snapshots.length === 0) {
        throw new Error('Could not capture viewport snapshots for Gemma vision review.');
      }

      const review = await api<Forge3DReview>(`/api/forge3d/assets/${targetAsset.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ imagesBase64: snapshots }),
      });

      setAssets((prev) =>
        prev.map((a) => (a.id === targetAsset.id ? { ...a, review } : a))
      );
      setSelectedAsset((prev) => (prev?.id === targetAsset.id ? { ...prev, review } : prev));
    } catch (err) {
      console.warn('Vision inspection error:', err);
      setError(`Vision inspection warning: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReviewing(false);
    }
  }, [api, captureSnapshots, reviewing]);

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

    // Interactive Viewport Lights (Cyan & Red)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0x38bdf8, 1.5);
    dirLight1.position.set(5, 10, 7);
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xf43f5e, 0.8);
    dirLight2.position.set(-5, -2, -5);
    scene.add(dirLight2);

    // Diagnostic 3-Point White Inspection Lights (Hidden during interactive viewing)
    const diagGroup = new THREE.Group();
    diagGroup.visible = false;
    diagnosticLightsRef.current = diagGroup;

    const diagKey = new THREE.DirectionalLight(0xffffff, 1.8);
    diagKey.position.set(5, 8, 6);
    diagGroup.add(diagKey);

    const diagFill = new THREE.DirectionalLight(0xffffff, 1.0);
    diagFill.position.set(-5, 3, -4);
    diagGroup.add(diagFill);

    const diagRim = new THREE.DirectionalLight(0xffffff, 0.6);
    diagRim.position.set(0, -6, -5);
    diagGroup.add(diagRim);

    const diagAmb = new THREE.AmbientLight(0xffffff, 1.2);
    diagGroup.add(diagAmb);

    scene.add(diagGroup);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 0.5, 3.5);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    rendererRef.current = renderer;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      if (!isDraggingRef.current && currentMeshRef.current && !reviewing) {
        currentMeshRef.current.rotation.y += 0.003;
      }
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container || !renderer || !camera) return;
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
  }, [reviewing]);

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

          // If autoReview is on, asset does not yet have a review, vision is active, and hasn't been attempted yet this session:
          if (autoReview && !selectedAsset.review && status?.lmStudio?.isMultimodal && !reviewedAttemptsRef.current.has(selectedAsset.id)) {
            reviewedAttemptsRef.current.add(selectedAsset.id);
            void triggerVisualReview(selectedAsset);
          }
        },
        undefined,
        (err) => {
          console.error('Failed to load GLB mesh in WebGL viewport:', err);
          setError(`Unable to parse or load 3D GLB model: ${err instanceof Error ? err.message : String(err)}`);
        }
      );
    }
  }, [selectedAsset, renderMode, wireframeOverlay, autoReview, status?.lmStudio?.isMultimodal, triggerVisualReview]);

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
      currentMeshRef.current.rotation.y += deltaX * 0.01;
      currentMeshRef.current.rotation.x += deltaY * 0.01;
    } else if (e.buttons === 2) {
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

  const handleInstallDependency = async (depId: string) => {
    try {
      setInstallingDepId(depId);
      setError('');
      await api('/api/forge3d/setup/install', {
        method: 'POST',
        body: JSON.stringify({ depId }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInstallingDepId(null);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadedImageName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      setUploadedImageBase64(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async () => {
    if (busy) return;
    if (inputMode === 'text_to_3d' && !prompt.trim()) return;
    if (inputMode === 'image_to_3d' && !uploadedImageBase64) {
      setError('Please select or upload a 2D reference image first.');
      return;
    }

    setBusy(true);
    setError('');

    try {
      let payload: any;
      if (inputMode === 'text_to_3d') {
        const preset = STYLE_PRESETS.find((p) => p.id === selectedStyle);
        const fullPrompt = `${prompt.trim()}${preset ? preset.promptSuffix : ''}`;
        payload = {
          mode: 'text_to_3d',
          prompt: fullPrompt,
          style: selectedStyle,
          autoReview,
        };
      } else {
        payload = {
          mode: 'image_to_3d',
          imageBase64: uploadedImageBase64,
          imageFilename: uploadedImageName,
          autoReview,
        };
      }

      const created = await api<Forge3DAsset>('/api/forge3d/generate', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAssets((current) => [created, ...current]);
      setSelectedAsset(created);
      if (inputMode === 'text_to_3d') setPrompt('');
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

  const handleRepair = async (asset: Forge3DAsset) => {
    if (!asset || repairing) return;
    try {
      setRepairing(true);
      setError('');
      const repaired = await api<Forge3DAsset>(`/api/forge3d/assets/${asset.id}/repair`, {
        method: 'POST',
      });
      setAssets((prev) => prev.map((a) => (a.id === repaired.id ? repaired : a)));
      setSelectedAsset(repaired);
    } catch (err) {
      setError(`Repair failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRepairing(false);
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
          <button className="icon-button mini" onClick={() => { void loadStatus(); void loadSetupStatus(); void loadAssets(); }} title="Refresh Services">
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
              <span className={`status-dot ${status?.lmStudio.isMultimodal ? 'online' : (status?.lmStudio.available ? 'warning' : 'offline')}`} />
              <strong>Gemma 12B Vision Reviewer</strong>
            </div>
            <span>
              {status?.lmStudio.isMultimodal
                ? `${status.lmStudio.model} (Vision Active)`
                : (status?.lmStudio.available
                  ? `${status.lmStudio.model} (Text Only, Vision Offline)`
                  : (status?.lmStudio.error ? 'Offline (:1234)' : 'Connecting...'))}
            </span>
          </div>
        </div>

        {/* ComfyUI Restart Required Notification */}
        {setupStatus?.restartRequired && (
          <div className="forge-setup-banner" style={{ borderColor: '#f59e0b', backgroundColor: '#78350f22' }}>
            <div className="setup-header">
              <AlertTriangle size={16} style={{ color: '#f59e0b' }} />
              <strong style={{ color: '#f59e0b' }}>Restart ComfyUI to Activate Nodes</strong>
            </div>
            <p style={{ margin: '6px 0 0 0', fontSize: '0.8rem', color: '#cbd5e1' }}>
              Custom nodes or Python packages were installed. Please restart ComfyUI to load TripoSR into memory.
            </p>
          </div>
        )}

        {/* Engine Setup & Auto-Downloader Banner if dependencies missing */}
        {setupStatus && setupStatus.missingCount > 0 && (
          <div className="forge-setup-banner">
            <div className="setup-header">
              <HardDriveDownload size={16} className="accent" />
              <strong>Engine Setup Required ({setupStatus.missingCount} missing)</strong>
            </div>
            <div className="setup-list">
              {setupStatus.items.map((dep) => (
                <div key={dep.id} className="setup-row">
                  <div className="setup-meta">
                    <span>{dep.name}</span>
                    <small>{dep.installed ? 'Installed ✓' : (dep.sizeBytes > 0 ? `${(dep.sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB missing` : 'Custom Node / Package missing')}</small>
                  </div>
                  {!dep.installed && (
                    <button
                      className="mini primary"
                      onClick={() => handleInstallDependency(dep.id)}
                      disabled={Boolean(installingDepId || (downloadProgress && downloadProgress.status === 'downloading'))}
                    >
                      {installingDepId === dep.id ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                      Install
                    </button>
                  )}
                </div>
              ))}
            </div>

            {downloadProgress && downloadProgress.status === 'downloading' && (
              <div className="download-progress-bar">
                <div className="progress-labels">
                  <span>Downloading {downloadProgress.fileName}</span>
                  <span>{downloadProgress.percent}% ({(downloadProgress.speedBytesPerSec / (1024 * 1024)).toFixed(1)} MB/s)</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${downloadProgress.percent}%` }} />
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="forge-error-box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
            <div style={{ flex: 1 }}>{error}</div>
            <button
              type="button"
              onClick={() => setError('')}
              style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', padding: 0, opacity: 0.8 }}
              title="Dismiss error"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Mode Selector Tabs */}
        <div className="forge-tabs">
          <button
            type="button"
            className={`tab-btn ${inputMode === 'text_to_3d' ? 'active' : ''}`}
            onClick={() => setInputMode('text_to_3d')}
          >
            <Wand2 size={13} /> Text to 3D
          </button>
          <button
            type="button"
            className={`tab-btn ${inputMode === 'image_to_3d' ? 'active' : ''}`}
            onClick={() => setInputMode('image_to_3d')}
          >
            <ImageIcon size={13} /> Image to 3D
          </button>
        </div>

        {/* Generation Input Box */}
        <div className="forge-form">
          {inputMode === 'text_to_3d' ? (
            <>
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
            </>
          ) : (
            <>
              <label>Reference 2D Concept Image</label>
              <div
                className="image-dropzone"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
                {uploadedImageBase64 ? (
                  <div className="image-preview-container">
                    <img src={uploadedImageBase64} alt="Upload preview" className="image-preview" />
                    <small>{uploadedImageName}</small>
                  </div>
                ) : (
                  <div className="dropzone-placeholder">
                    <Upload size={24} className="dropzone-icon" />
                    <span>Click or drag 2D image here</span>
                    <small>PNG, JPG, WEBP (Neural background remover applied)</small>
                  </div>
                )}
              </div>
            </>
          )}

          <label className={`checkbox-row ${!status?.lmStudio?.isMultimodal ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={autoReview && Boolean(status?.lmStudio?.isMultimodal)}
              onChange={(e) => setAutoReview(e.target.checked)}
              disabled={!status?.lmStudio?.isMultimodal}
            />
            <span>
              Gemma Vision QA Review {status?.lmStudio?.isMultimodal ? '($0 local GPU)' : '(Requires Multimodal Model in LM Studio)'}
            </span>
          </label>

          <button
            className="primary forge-btn"
            onClick={handleGenerate}
            disabled={busy || (setupStatus !== null && !setupStatus.readyFor3D) || (inputMode === 'text_to_3d' && !prompt.trim()) || (inputMode === 'image_to_3d' && !uploadedImageBase64)}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
            {busy ? 'Reconstructing 3D Mesh on GPU...' : (setupStatus && !setupStatus.readyFor3D ? 'Engine Setup Required' : (inputMode === 'text_to_3d' ? 'Forge 3D Asset' : 'Reconstruct from Image'))}
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

            <button
              className={`icon-button mini ${reviewing ? 'active' : ''}`}
              onClick={() => selectedAsset && triggerVisualReview(selectedAsset)}
              disabled={!selectedAsset || reviewing}
              title="Inspect 3D Geometry with Gemma 12B Vision (6 Standard Views, White Lighting)"
            >
              {reviewing ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
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

        {/* Floating 2D Concept Thumbnail if available */}
        {selectedAsset?.previewUrl && (
          <div className="floating-concept-card" title="2D Reference / Concept Art">
            <span>2D Concept</span>
            <img src={selectedAsset.previewUrl} alt="2D Concept" />
          </div>
        )}

        {/* Bottom Review & Mesh Statistics Overlay */}
        {selectedAsset && (
          <div className="viewport-overlay-panel">
            {selectedAsset.review && (
              <div className="vision-critique-card">
                <div className="critique-header">
                  <Sparkles size={14} className="accent" />
                  <strong>Gemma 12B Vision Inspection:</strong>
                  <span className={`critique-verdict ${selectedAsset.review.verdict}`}>
                    {selectedAsset.review.verdict.toUpperCase()} ({selectedAsset.review.score}/100)
                  </span>
                </div>
                <p>{selectedAsset.review.critique}</p>
                {selectedAsset.review.suggestedPromptRefinements && (
                  <div className="refinement-tip">
                    <small>Suggested refinement: {selectedAsset.review.suggestedPromptRefinements}</small>
                  </div>
                )}
                {selectedAsset.review.verdict === 'needs_repair' && (
                  <div className="repair-action-row" style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                    <button
                      className="primary mini-btn"
                      onClick={() => handleRepair(selectedAsset)}
                      disabled={repairing || selectedAsset.iterations >= 3}
                    >
                      {repairing ? <Loader2 size={12} className="spin" /> : <Wrench size={12} />}
                      {repairing ? 'Repairing Mesh on GPU...' : `Auto-Repair Defect (Iter ${selectedAsset.iterations}/3)`}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="mesh-stats-bar">
              <span>Format: <strong>{selectedAsset.modelFormat.toUpperCase()}</strong></span>
              <span>Vertices: <strong>{selectedAsset.vertexCount.toLocaleString()}</strong></span>
              <span>Faces: <strong>{selectedAsset.triangleCount.toLocaleString()}</strong></span>
              {selectedAsset.isWatertight !== undefined && (
                <span className={`review-tag ${selectedAsset.isWatertight ? 'pass' : 'needs_repair'}`}>
                  {selectedAsset.isWatertight ? '✓ Watertight' : 'Open Mesh'}
                </span>
              )}
              <span>Size: <strong>{(selectedAsset.fileSizeBytes / 1024).toFixed(1)} KB</strong></span>
              <div className="export-btn-group" style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
                <a
                  href={`/api/forge3d/assets/${selectedAsset.id}/export?format=glb`}
                  download={`${selectedAsset.id}.glb`}
                  className="secondary mini-btn"
                  title="Download binary glTF (.glb)"
                >
                  <Download size={12} /> .GLB
                </a>
                <a
                  href={`/api/forge3d/assets/${selectedAsset.id}/export?format=obj`}
                  download={`${selectedAsset.id}.obj`}
                  className="secondary mini-btn"
                  title="Download Wavefront OBJ"
                >
                  <Download size={12} /> .OBJ
                </a>
                <a
                  href={`/api/forge3d/assets/${selectedAsset.id}/export?format=stl`}
                  download={`${selectedAsset.id}.stl`}
                  className="secondary mini-btn"
                  title="Download 3D Printable STL"
                >
                  <Download size={12} /> .STL
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
