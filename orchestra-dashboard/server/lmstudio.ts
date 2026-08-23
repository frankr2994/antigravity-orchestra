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

type FetchLike = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Parse the documented LM Studio GET /api/v1/models response. */
export function parseLmStudioV1Models(value: unknown): LmStudioInstalledModel[] {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.models)) {
    throw new TypeError('LM Studio /api/v1/models response must contain a models array');
  }

  return body.models.map((raw, index) => {
    const item = asRecord(raw);
    if (!item || typeof item.key !== 'string' || item.key.length === 0) {
      throw new TypeError(`LM Studio model at index ${index} is missing key`);
    }
    if (!Array.isArray(item.loaded_instances)) {
      throw new TypeError(`LM Studio model ${item.key} is missing loaded_instances`);
    }

    const loadedInstance = asRecord(item.loaded_instances[0]);
    const loadedConfig = asRecord(loadedInstance?.config);
    const quantization = asRecord(item.quantization);
    const capabilities = asRecord(item.capabilities);
    const enabledCapabilities = capabilities
      ? Object.entries(capabilities)
          .filter(([, enabled]) => enabled === true)
          .map(([name]) => name)
      : undefined;

    return {
      id: item.key,
      displayName: optionalString(item.display_name),
      publisher: optionalString(item.publisher),
      arch: optionalString(item.architecture),
      quantization: optionalString(quantization?.name),
      state: item.loaded_instances.length > 0 ? 'loaded' : 'not-loaded',
      maxContextLength: optionalNumber(item.max_context_length),
      loadedContextLength: optionalNumber(loadedConfig?.context_length),
      sizeBytes: optionalNumber(item.size_bytes),
      paramsString: optionalString(item.params_string),
      type: optionalString(item.type),
      capabilities: enabledCapabilities,
    };
  });
}

function parseLegacyModels(value: unknown): LmStudioInstalledModel[] {
  const body = asRecord(value);
  const rawList = Array.isArray(body?.models)
    ? body.models
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(value)
        ? value
        : null;
  if (!rawList) throw new TypeError('Legacy model response does not contain an array');

  return rawList.flatMap((raw) => {
    const item = asRecord(raw);
    const id = optionalString(item?.id) ?? optionalString(item?.key) ?? optionalString(item?.path);
    if (!item || !id || item.type === 'embeddings') return [];
    const quantization = asRecord(item.quantization);
    return [{
      id,
      displayName: optionalString(item.displayName) ?? optionalString(item.name),
      publisher: optionalString(item.publisher),
      arch: optionalString(item.arch) ?? optionalString(item.architecture),
      quantization: optionalString(item.quantization) ?? optionalString(quantization?.name),
      state: item.state === 'loaded' || item.loaded === true || item.isLoaded === true ? 'loaded' : 'not-loaded',
      maxContextLength: optionalNumber(item.max_context_length) ?? optionalNumber(item.maxContextLength),
      loadedContextLength: optionalNumber(item.loaded_context_length) ?? optionalNumber(item.loadedContextLength),
      sizeBytes: optionalNumber(item.sizeBytes) ?? optionalNumber(item.size_bytes),
      paramsString: optionalString(item.paramsString) ?? optionalString(item.params),
      type: optionalString(item.type),
      capabilities: Array.isArray(item.capabilities) ? item.capabilities.map(String) : undefined,
    } satisfies LmStudioInstalledModel];
  });
}

export async function getInstalledLmStudioModels(fetchImpl: FetchLike = fetch): Promise<LmStudioInstalledModel[]> {
  const rawBase = config.lmStudioBaseUrl || 'http://localhost:1234/v1';
  const serverRoot = rawBase.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const v1Base = `${serverRoot}/v1`;

  // The documented API is authoritative. Older endpoints remain compatibility fallbacks.
  const nativeEndpoints = [
    { url: `${serverRoot}/api/v1/models`, parse: parseLmStudioV1Models },
    { url: `${serverRoot}/api/v0/models`, parse: parseLegacyModels },
  ];
  for (const endpoint of nativeEndpoints) {
    try {
      const response = await fetchImpl(endpoint.url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return endpoint.parse(await response.json());
      }
    } catch {
      // Continue to next endpoint
    }
  }

  // 2. Fallback to standard OpenAI-compatible /v1/models endpoint
  try {
    const response = await fetchImpl(`${v1Base}/models`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
      if (Array.isArray(body.data)) {
        return parseLegacyModels(body);
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
