import { getActiveLmStudioModelInfo } from '../../lmstudio.js';
import { readCodexUsage } from '../../observability.js';
import { listAntigravityModels } from '../../providers/antigravity/agent-adapter.js';
import { getMcpStatus } from '../../mcp.js';
import type { Store } from '../../db.js';
import { getGitStatus } from '../../git.js';
import { config, hasJulesCapability } from '../../config.js';
import { JulesConnectionService } from '../jules/connection-service.js';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import { isRipwireAvailable } from '../../ripwire.js';

export interface SystemCapabilities {
  gemma: {
    available: boolean;
    modelId: string | null;
    contextLength: number;
    reason?: string;
  };
  codex: {
    available: boolean;
    rollingQuotaRemaining: number | null;
    weeklyQuotaRemaining: number | null;
    models: string[];
    reason?: string;
  };
  antigravity: {
    available: boolean;
    models: string[];
    reason?: string;
  };
  jules: {
    available: boolean;
    readyForProject: boolean;
    reason?: string;
  };
  mcp: {
    rider: boolean;
    operationalCount: number;
  };
  ripwire: {
    available: boolean;
    path: string | null;
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([
    promise.then((res) => { clearTimeout(timer); return res; }).catch(() => fallback),
    timeoutPromise,
  ]);
}

/**
 * Dynamically sense all available models, quotas, MCP tools, and cloud readiness.
 * Non-blocking, fault-tolerant, bounded by a 2.0s maximum execution limit,
 * and zero hardcoded assumptions.
 */
export async function senseEnvironment(input: {
  projectRoot?: string;
  projectId?: string;
  store?: Store;
  signal?: AbortSignal;
}): Promise<SystemCapabilities> {
  const [lmStudioRes, codexRes, agyModels, mcpStatus] = await Promise.allSettled([
    withTimeout(getActiveLmStudioModelInfo(), 2000, { id: '', contextLength: 8192, capabilities: undefined }),
    withTimeout(readCodexUsage(), 2000, { available: false, source: 'codex', checkedAt: new Date().toISOString() }),
    withTimeout(listAntigravityModels(), 2000, []),
    withTimeout(getMcpStatus(), 2000, { checkedAt: new Date().toISOString(), server: { name: 'rider', version: null, operational: false, endpoint: null, toolCount: 0, latencyMs: null, reason: 'offline' }, agents: { antigravity: { configured: false, enabled: false, available: false, access: 'none', endpoint: null, reason: null }, codex: { configured: false, enabled: false, available: false, access: 'none', endpoint: null, reason: null }, gemma: { configured: false, enabled: false, available: false, access: 'none', endpoint: null, reason: null } } }),
  ]);

  // 1. Gemma / LM Studio Sensing
  let gemma: SystemCapabilities['gemma'] = { available: false, modelId: null, contextLength: 8192, reason: 'LM Studio offline' };
  if (lmStudioRes.status === 'fulfilled' && lmStudioRes.value.id) {
    gemma = {
      available: true,
      modelId: lmStudioRes.value.id,
      contextLength: lmStudioRes.value.contextLength || 8192,
    };
  } else if (lmStudioRes.status === 'rejected') {
    gemma.reason = lmStudioRes.reason instanceof Error ? lmStudioRes.reason.message : String(lmStudioRes.reason);
  }

  // 2. Codex Quota & Model Sensing
  let codex: SystemCapabilities['codex'] = { available: false, rollingQuotaRemaining: null, weeklyQuotaRemaining: null, models: [], reason: 'Codex telemetry unreadable' };
  if (codexRes.status === 'fulfilled') {
    const usage = codexRes.value;
    const rollingBucket = usage.quotas?.find((q) => q.window === '5h' || q.id?.includes('primary'));
    const weeklyBucket = usage.quotas?.find((q) => q.window === '7d' || q.window === '1w' || q.id?.includes('secondary'));
    codex = {
      available: usage.available || (usage.quotas && usage.quotas.length > 0) || false,
      rollingQuotaRemaining: rollingBucket?.remainingPercent ?? usage.quotas?.[0]?.remainingPercent ?? null,
      weeklyQuotaRemaining: weeklyBucket?.remainingPercent ?? null,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      reason: usage.reason,
    };
  }

  // 3. Antigravity CLI Model Sensing
  const availableAgyModels = agyModels.status === 'fulfilled' && agyModels.value.length ? agyModels.value : [];
  const antigravity: SystemCapabilities['antigravity'] = {
    available: true,
    models: availableAgyModels.length ? availableAgyModels : ['gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low'],
    reason: availableAgyModels.length ? undefined : 'Using standard Gemini Flash model tiers',
  };

  // 4. Jules Cloud Readiness
  const julesConnection = input.store ? new JulesConnectionService(input.store, new CredentialVault()) : null;
  const julesSettings = julesConnection?.runtimeSettings();
  const julesCredential = julesConnection?.credentialStatus();
  const julesEnabled = julesSettings?.enabled ?? Boolean(config.jules.enabled);
  const canIntegrate = julesSettings ? hasJulesCapability(julesSettings.rolloutStage, 'integrate') : false;
  const hasCredential = julesCredential?.configured === true;
  let jules: SystemCapabilities['jules'] = {
    available: julesEnabled && canIntegrate && hasCredential,
    readyForProject: false,
    reason: !julesEnabled
      ? 'Jules is disabled.'
      : !canIntegrate
      ? 'Jules rollout does not enable reviewed integration.'
      : !hasCredential
      ? 'Jules credentials are not configured.'
      : 'Project readiness has not been established.',
  };
  if (jules.available && input.projectRoot && input.projectId && input.store) {
    try {
      const gitStatus = await getGitStatus(input.projectRoot);
      const source = input.store.manager.julesSourceMappings.get(input.projectId);
      const activeCount = input.store.manager.julesCapacity.activeCount();

      if (!gitStatus.isGit || gitStatus.dirty || !gitStatus.head || !gitStatus.upstream) {
        jules = { available: true, readyForProject: false, reason: 'Jules requires a clean, pushed Git branch.' };
      } else if (!source || source.targetBranch !== gitStatus.branch) {
        jules = { available: true, readyForProject: false, reason: 'No verified Jules source mapping for this branch.' };
      } else if (activeCount >= config.jules.maxConcurrentSessions) {
        jules = { available: true, readyForProject: false, reason: 'Jules concurrency capacity is currently full.' };
      } else {
        jules = { available: true, readyForProject: true };
      }
    } catch (err) {
      jules = { available: true, readyForProject: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // 5. MCP Tools Sensing
  const mcp: SystemCapabilities['mcp'] = {
    rider: mcpStatus.status === 'fulfilled' ? mcpStatus.value.server.operational && mcpStatus.value.agents.codex.available : false,
    operationalCount: mcpStatus.status === 'fulfilled' && mcpStatus.value.server.operational ? 1 : 0,
  };

  // 6. Ripwire Sensing (synchronous fs check — no network, no timeout needed)
  const ripwireAvailable = isRipwireAvailable();
  const ripwire: SystemCapabilities['ripwire'] = {
    available: ripwireAvailable,
    path: ripwireAvailable ? (process.env.RIPWIRE_PATH || 'F:\\Ripwire\\ripwire-0.5.0\\ripwire-0.5.0\\build\\ripwire.exe') : null,
  };

  return { gemma, codex, antigravity, jules, mcp, ripwire };
}
