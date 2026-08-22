import { config } from './config.js';
import { runProcess } from './process.js';

// ============================================================================
// LM Studio Local Model Management
// ============================================================================

export interface LmStudioInstalledModel {
  id: string;
  displayName?: string;
  publisher?: string;
  arch?: string;
  quantization?: string;
  state: 'loaded' | 'not-loaded';
  maxContextLength?: number;
  loadedContextLength?: number;
  sizeBytes?: number;
  paramsString?: string;
  type?: string;
  capabilities?: string[];
}

export async function getInstalledLmStudioModels(): Promise<LmStudioInstalledModel[]> {
  const rawBase = config.lmStudioBaseUrl || 'http://localhost:1234/v1';
  const serverRoot = rawBase.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const v1Base = `${serverRoot}/v1`;

  // 1. Try native LM Studio endpoint (/api/v0/models or /api/v1/models)
  const nativeEndpoints = [`${serverRoot}/api/v0/models`, `${serverRoot}/api/v1/models`];
  for (const endpoint of nativeEndpoints) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>;
        const rawList = Array.isArray(body.models)
          ? body.models
          : Array.isArray(body.data)
            ? body.data
            : Array.isArray(body)
              ? body
              : null;

        if (rawList && rawList.length > 0) {
          return rawList
            .filter((item: any) => item && (item.id || item.key || item.path) && item.type !== 'embeddings')
            .map((item: any) => {
              const id = String(item.id || item.key || item.path);
              const isLoaded = item.state === 'loaded' || item.loaded === true || item.isLoaded === true;
              return {
                id,
                displayName: typeof item.displayName === 'string' ? item.displayName : typeof item.name === 'string' ? item.name : undefined,
                publisher: typeof item.publisher === 'string' ? item.publisher : undefined,
                arch: typeof item.arch === 'string' ? item.arch : item.architecture,
                quantization: typeof item.quantization === 'string' ? item.quantization : item.quantization?.name,
                state: isLoaded ? ('loaded' as const) : ('not-loaded' as const),
                maxContextLength: typeof item.max_context_length === 'number' ? item.max_context_length : item.maxContextLength,
                loadedContextLength: typeof item.loaded_context_length === 'number' ? item.loaded_context_length : item.loadedContextLength,
                sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : item.size_bytes,
                paramsString: typeof item.paramsString === 'string' ? item.paramsString : item.params,
                type: typeof item.type === 'string' ? item.type : undefined,
                capabilities: Array.isArray(item.capabilities) ? item.capabilities.map(String) : undefined,
              };
            });
        }
      }
    } catch {
      // Continue to next endpoint
    }
  }

  // 2. Fallback to standard OpenAI-compatible /v1/models endpoint
  try {
    const response = await fetch(`${v1Base}/models`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
      if (Array.isArray(body.data)) {
        return body.data
          .filter((item) => item && item.id)
          .map((item) => {
            const isLoaded = item.state === 'loaded' || item.loaded === true || item.isLoaded === true;
            return {
              id: String(item.id),
              displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
              state: isLoaded ? ('loaded' as const) : ('not-loaded' as const),
            };
          });
      }
    }
  } catch {
    /* Offline */
  }

  return [];
}

export async function getLoadedLmStudioModels(): Promise<string[]> {
  const models = await getInstalledLmStudioModels();
  return models.filter((m) => m.state === 'loaded').map((m) => m.id);
}

export async function getActiveLmStudioModel(): Promise<string> {
  const loaded = await getLoadedLmStudioModels();
  if (loaded.length > 0) return loaded[0]!;
  return config.lmStudioModel;
}

export async function loadLmStudioModel(
  modelId: string,
  options?: { gpu?: string; contextLength?: number }
): Promise<{ ok: boolean; message: string; activeModel?: string }> {
  try {
    // 1. Unload all currently loaded models first to free 100% GPU VRAM
    await runProcess('lms', ['unload', '--all'], { timeoutMs: 30_000 }).catch(() => {
      /* ignore */
    });

    // 2. Load target model
    const args = ['load', modelId, '-y'];
    if (options?.gpu) args.push('--gpu', options.gpu);
    else args.push('--gpu', 'max');
    if (options?.contextLength) args.push('--context-length', String(options.contextLength));

    const result = await runProcess('lms', args, { timeoutMs: 90_000 });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `lms load exited with code ${result.code}`);
    }

    return { ok: true, message: `Loaded model ${modelId}`, activeModel: modelId };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function unloadLmStudioModel(modelId?: string): Promise<{ ok: boolean; message: string }> {
  try {
    const args = modelId ? ['unload', modelId] : ['unload', '--all'];
    const result = await runProcess('lms', args, { timeoutMs: 30_000 });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `lms unload exited with code ${result.code}`);
    }
    return { ok: true, message: modelId ? `Unloaded model ${modelId}` : 'Unloaded all local models' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
