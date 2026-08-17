import { existsSync, statSync, createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findComfyInstallation, getComfyStatus } from './comfy.js';

const execFileAsync = promisify(execFile);

export interface ForgeDependencyItem {
  id: string;
  name: string;
  category: 'model' | 'node' | 'python_pkg';
  targetSubdir: string;
  fileName: string;
  downloadUrl: string;
  sizeBytes: number;
  sha256?: string;
  description: string;
  required: boolean;
}

export interface DependencyStatus extends ForgeDependencyItem {
  installed: boolean;
  actualSizeBytes?: number;
  localPath: string;
}

export interface ForgeSetupStatus {
  comfyFound: boolean;
  comfyPath: string | null;
  comfyRunning: boolean;
  readyFor3D: boolean;
  restartRequired: boolean;
  items: DependencyStatus[];
  missingCount: number;
  missingBytes: number;
}

export const FORGE_DEPENDENCIES: ForgeDependencyItem[] = [
  {
    id: 'triposr-model',
    name: 'TripoSR 3D Neural Weights',
    category: 'model',
    targetSubdir: 'models/checkpoints',
    fileName: 'model.ckpt',
    downloadUrl: 'https://huggingface.co/stabilityai/TripoSR/resolve/main/model.ckpt',
    sizeBytes: 1677246742,
    description: 'Core 1.56 GB neural reconstructor for single-image to 3D mesh synthesis.',
    required: true,
  },
  {
    id: 'concept-sd15',
    name: '2D Concept Generator (SD 1.5 Base)',
    category: 'model',
    targetSubdir: 'models/checkpoints',
    fileName: 'v1-5-pruned-emaonly.safetensors',
    downloadUrl: 'https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
    sizeBytes: 2132536836,
    description: 'Compact 2.0 GB checkpoint for rendering isolated 2D concept art from text prompts.',
    required: true,
  },
  {
    id: 'flowty-triposr-node',
    name: 'ComfyUI-Flowty-TripoSR Custom Node',
    category: 'node',
    targetSubdir: 'custom_nodes/ComfyUI-Flowty-TripoSR',
    fileName: '__init__.py',
    downloadUrl: 'https://github.com/flowtyone/ComfyUI-Flowty-TripoSR.git',
    sizeBytes: 0,
    description: 'ComfyUI node wrapper providing TripoSRModelLoader and TripoSRSampler.',
    required: true,
  },
  {
    id: 'rembg-pkg',
    name: 'Neural Background Remover Packages (rembg)',
    category: 'python_pkg',
    targetSubdir: '',
    fileName: 'rembg',
    downloadUrl: 'rembg onnxruntime trimesh[easy]',
    sizeBytes: 0,
    description: 'Background removal and alpha masking engine for isolated silhouette synthesis.',
    required: true,
  },
  {
    id: 'rembg-model',
    name: 'rembg Segmentation Model (u2net.onnx)',
    category: 'model',
    targetSubdir: '.u2net',
    fileName: 'u2net.onnx',
    downloadUrl: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
    sizeBytes: 176296316,
    description: 'Official U2-Net 176 MB ONNX neural weights for foreground subject segmentation.',
    required: true,
  },
];

export async function probePythonPackages(pythonPath: string, packages: string[]): Promise<boolean> {
  try {
    const pkgListJson = JSON.stringify(packages);
    const script = `import importlib.util; pkgs = ${pkgListJson}; ok = all(importlib.util.find_spec(p) is not None for p in pkgs); print("OK" if ok else "MISSING")`;
    const { stdout } = await execFileAsync(pythonPath, ['-c', script], { timeout: 15000 });
    return stdout.trim().endsWith('OK');
  } catch {
    return false;
  }
}

export async function checkForgeDependencies(): Promise<ForgeSetupStatus> {
  const installation = findComfyInstallation();
  const comfyStatus = await getComfyStatus();

  if (!installation) {
    return {
      comfyFound: false,
      comfyPath: null,
      comfyRunning: comfyStatus.available,
      readyFor3D: false,
      restartRequired: false,
      items: FORGE_DEPENDENCIES.map((dep) => ({
        ...dep,
        installed: false,
        localPath: '',
      })),
      missingCount: FORGE_DEPENDENCIES.length,
      missingBytes: FORGE_DEPENDENCIES.reduce((acc, d) => acc + d.sizeBytes, 0),
    };
  }

  const items: DependencyStatus[] = [];

  for (const dep of FORGE_DEPENDENCIES) {
    let localPath = '';
    let installed = false;
    let actualSizeBytes: number | undefined;

    if (dep.category === 'model') {
      if (dep.id === 'rembg-model') {
        localPath = join(homedir(), '.u2net', dep.fileName);
      } else {
        localPath = join(installation.comfyCoreDir, dep.targetSubdir, dep.fileName);
      }

      if (existsSync(localPath)) {
        try {
          const st = statSync(localPath);
          actualSizeBytes = st.size;
          installed = st.size >= (dep.sizeBytes * 0.9);
        } catch {
          installed = false;
        }
      }
    } else if (dep.category === 'node') {
      localPath = join(installation.comfyCoreDir, dep.targetSubdir);
      const initPy = join(localPath, dep.fileName);
      installed = existsSync(initPy);
    } else if (dep.category === 'python_pkg') {
      localPath = 'Python environment';
      const pkgsToCheck = dep.id === 'rembg-pkg' ? ['rembg', 'onnxruntime', 'trimesh', 'PIL', 'numpy'] : ['trimesh'];
      installed = await probePythonPackages(installation.pythonPath, pkgsToCheck);
    }

    items.push({
      ...dep,
      installed,
      actualSizeBytes,
      localPath,
    });
  }

  const missing = items.filter((i) => i.required && !i.installed);
  const missingBytes = missing.reduce((acc, i) => acc + (i.sizeBytes || 0), 0);

  // Dynamic restart requirement check: If Flowty custom node is installed on disk but ComfyUI process hasn't loaded it
  const flowtyInstalled = items.find((i) => i.id === 'flowty-triposr-node')?.installed;
  const restartRequired = Boolean(comfyStatus.available && flowtyInstalled && !comfyStatus.tripoReady);

  const readyFor3D = Boolean(comfyStatus.available && comfyStatus.tripoReady && missing.length === 0 && !restartRequired);

  return {
    comfyFound: true,
    comfyPath: installation.rootPath,
    comfyRunning: comfyStatus.available,
    readyFor3D,
    restartRequired,
    items,
    missingCount: missing.length,
    missingBytes,
  };
}

export interface ActiveDownloadProgress {
  depId: string;
  fileName: string;
  bytesReceived: number;
  totalBytes: number;
  percent: number;
  speedBytesPerSec: number;
  status: 'downloading' | 'verifying' | 'completed' | 'error';
  error?: string;
}

let activeDownload: ActiveDownloadProgress | null = null;
let downloadAbortController: AbortController | null = null;

export function getDownloadProgress(): ActiveDownloadProgress | null {
  return activeDownload;
}

export async function installForgeDependency(depId: string): Promise<void> {
  const dep = FORGE_DEPENDENCIES.find((d) => d.id === depId);
  if (!dep) throw new Error(`Unknown dependency ID: ${depId}`);

  const installation = findComfyInstallation();
  if (!installation) throw new Error('ComfyUI installation directory not found on system.');

  activeDownload = {
    depId,
    fileName: dep.name,
    bytesReceived: 0,
    totalBytes: dep.sizeBytes || 100,
    percent: 0,
    speedBytesPerSec: 0,
    status: 'downloading',
  };

  if (dep.category === 'node') {
    const targetDir = join(installation.comfyCoreDir, dep.targetSubdir);
    try {
      activeDownload.percent = 20;
      if (!existsSync(targetDir)) {
        await execFileAsync('git', ['clone', dep.downloadUrl, targetDir]);
      } else {
        await execFileAsync('git', ['-C', targetDir, 'pull']);
      }

      activeDownload.percent = 60;
      const reqFile = join(targetDir, 'requirements.txt');
      if (existsSync(reqFile)) {
        await execFileAsync(installation.pythonPath, ['-m', 'pip', 'install', '-r', reqFile]);
      }

      activeDownload.percent = 100;
      activeDownload.status = 'completed';
    } catch (err) {
      activeDownload.status = 'error';
      activeDownload.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return;
  }

  if (dep.category === 'python_pkg') {
    try {
      activeDownload.percent = 30;
      const pkgs = dep.downloadUrl.split(' ');
      await execFileAsync(installation.pythonPath, ['-m', 'pip', 'install', ...pkgs]);
      activeDownload.percent = 100;
      activeDownload.status = 'completed';
    } catch (err) {
      activeDownload.status = 'error';
      activeDownload.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return;
  }

  if (dep.category === 'model') {
    let targetDir: string;
    if (dep.id === 'rembg-model') {
      targetDir = join(homedir(), '.u2net');
    } else {
      targetDir = join(installation.comfyCoreDir, dep.targetSubdir);
    }
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, dep.fileName);
    const tempPath = `${targetPath}.part`;

    downloadAbortController = new AbortController();

    let startBytes = 0;
    if (existsSync(tempPath)) {
      try {
        startBytes = statSync(tempPath).size;
      } catch {
        startBytes = 0;
      }
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 AntigravityOrchestra/1.0',
    };
    if (startBytes > 0) {
      headers['Range'] = `bytes=${startBytes}-`;
    }

    try {
      const res = await fetch(dep.downloadUrl, {
        headers,
        signal: downloadAbortController.signal,
      });

      if (!res.ok && res.status !== 416) {
        throw new Error(`Download failed with HTTP ${res.status}: ${res.statusText}`);
      }

      // If server returned 416 (Range Not Satisfiable), delete .part and start cleanly from byte 0
      if (res.status === 416) {
        const { unlinkSync } = await import('node:fs');
        if (existsSync(tempPath)) unlinkSync(tempPath);
        startBytes = 0;
        return installForgeDependency(depId);
      }

      // CRITICAL FIX: Only append if server honored Range with HTTP 206 Partial Content.
      // If server sent HTTP 200 (OK), it ignored Range and sent the whole file from byte 0.
      const isPartialContent = res.status === 206;
      if (!isPartialContent && startBytes > 0) {
        startBytes = 0;
      }

      const totalLengthHeader = res.headers.get('content-length');
      const totalBytes = totalLengthHeader
        ? parseInt(totalLengthHeader, 10) + startBytes
        : dep.sizeBytes;
      activeDownload.totalBytes = totalBytes;

      const fileStream = createWriteStream(tempPath, { flags: isPartialContent && startBytes > 0 ? 'a' : 'w' });
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Failed to get readable stream from response.');

      let received = startBytes;
      let lastTime = Date.now();
      let lastBytes = received;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fileStream.write(Buffer.from(value));
        received += value.length;

        const now = Date.now();
        const deltaSec = (now - lastTime) / 1000;
        let speed = activeDownload.speedBytesPerSec;
        if (deltaSec >= 0.5) {
          speed = (received - lastBytes) / deltaSec;
          lastTime = now;
          lastBytes = received;
        }

        activeDownload.bytesReceived = received;
        activeDownload.percent = Math.min(100, Math.round((received / totalBytes) * 100));
        activeDownload.speedBytesPerSec = speed;
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end(() => resolve());
        fileStream.on('error', reject);
      });

      activeDownload.status = 'verifying';
      const finalStat = statSync(tempPath);
      if (finalStat.size < dep.sizeBytes * 0.9 && finalStat.size !== dep.sizeBytes) {
        throw new Error(`Downloaded file size (${finalStat.size} bytes) is incomplete (expected ${dep.sizeBytes} bytes).`);
      }

      // Check SHA-256 if defined in dependency item
      if (dep.sha256) {
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha256');
        const fileBuf = readFileSync(tempPath);
        hash.update(fileBuf);
        const digest = hash.digest('hex');
        if (digest.toLowerCase() !== dep.sha256.toLowerCase()) {
          throw new Error(`Downloaded file failed SHA-256 checksum verification (got ${digest}, expected ${dep.sha256})`);
        }
      }

      const { renameSync, unlinkSync } = await import('node:fs');
      if (existsSync(targetPath)) unlinkSync(targetPath);
      renameSync(tempPath, targetPath);

      activeDownload.status = 'completed';
      activeDownload.percent = 100;
    } catch (err) {
      activeDownload.status = 'error';
      activeDownload.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      downloadAbortController = null;
    }
  }
}
