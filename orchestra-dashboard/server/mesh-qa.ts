import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findComfyInstallation } from './comfy.js';

const execFileAsync = promisify(execFile);

export interface MeshBoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  extents: [number, number, number];
}

export interface MeshQAStats {
  valid: boolean;
  vertexCount: number;
  triangleCount: number;
  isWatertight: boolean;
  eulerNumber: number;
  boundingBox: MeshBoundingBox;
  surfaceArea: number;
  sizeBytes: number;
  error?: string;
}

export async function sanitizeAndExportGlb(
  inputModelPath: string,
  outputGlbPath: string
): Promise<MeshQAStats> {
  if (!existsSync(inputModelPath)) {
    throw new Error(`Input model file does not exist at ${inputModelPath}`);
  }

  const installation = findComfyInstallation();
  const pythonPath = installation?.pythonPath || (process.platform === 'win32' ? 'python.exe' : 'python3');

  const pyScript = `
import trimesh
import json
import sys
import numpy as np

try:
    mesh = trimesh.load(${JSON.stringify(inputModelPath)}, force='mesh')
    
    if hasattr(mesh, 'is_empty') and mesh.is_empty:
        print(json.dumps({'valid': False, 'error': 'Reconstructed mesh is empty (0 vertices/faces)'}))
        sys.exit(1)

    # 1. Finite coordinate check
    if not np.all(np.isfinite(mesh.vertices)):
        print(json.dumps({'valid': False, 'error': 'Mesh contains NaN or Infinite vertex coordinates'}))
        sys.exit(1)

    # 2. Cleanup & sanitization
    mesh.remove_degenerate_faces()
    mesh.remove_duplicate_faces()
    mesh.remove_unreferenced_vertices()
    mesh.process(validate=True)
    mesh.fix_normals()

    # 3. Center and normalize scale
    centroid = mesh.centroid
    mesh.vertices -= centroid
    extents = mesh.extents
    max_dim = float(np.max(extents)) if len(extents) > 0 else 1.0
    if max_dim > 0:
        scale_factor = 2.0 / max_dim
        mesh.vertices *= scale_factor

    # 4. Export binary glTF (.glb)
    mesh.export(${JSON.stringify(outputGlbPath)})

    # 5. Extract deterministic topology metrics
    bounds = mesh.bounds
    min_pt = [float(x) for x in bounds[0]]
    max_pt = [float(x) for x in bounds[1]]
    ext = [float(x) for x in mesh.extents]
    
    stats = {
        'valid': True,
        'vertexCount': int(len(mesh.vertices)),
        'triangleCount': int(len(mesh.faces)),
        'isWatertight': bool(mesh.is_watertight),
        'eulerNumber': int(mesh.euler_number),
        'surfaceArea': float(mesh.area),
        'boundingBox': {
            'min': min_pt,
            'max': max_pt,
            'extents': ext
        }
    }
    print(json.dumps(stats))

except Exception as e:
    print(json.dumps({'valid': False, 'error': str(e)}))
    sys.exit(1)
`;

  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', pyScript]);
    const lastLine = stdout.trim().split('\n').pop() || '{}';
    const parsed = JSON.parse(lastLine);

    if (!parsed.valid || parsed.error) {
      throw new Error(`Mesh QA failed: ${parsed.error || 'Invalid geometry'}`);
    }

    if (!existsSync(outputGlbPath)) {
      throw new Error(`Sanitized GLB export failed to create file at ${outputGlbPath}`);
    }

    const glbBuffer = readFileSync(outputGlbPath);

    return {
      valid: true,
      vertexCount: parsed.vertexCount,
      triangleCount: parsed.triangleCount,
      isWatertight: parsed.isWatertight,
      eulerNumber: parsed.eulerNumber,
      boundingBox: parsed.boundingBox,
      surfaceArea: parsed.surfaceArea,
      sizeBytes: glbBuffer.length,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Mesh QA failed:')) {
      throw err;
    }
    throw new Error(`Trimesh QA execution error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
