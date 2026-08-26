import type { Store } from '../../db.js';
import type { ExecutionTarget, TaskClassification, WorkerIdentity } from '../../domain/index.js';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import type { JulesApiClient } from './client.js';
import { resolveJulesApiKey } from './credentials.js';
import { runJulesPreflight } from './preflight.js';
import { decideFreeFirstRoute, isGemmaMicroEditCandidate } from '../../domain/index.js';

// ============================================================================
// Google Jules & Orchestra Dynamic Task Routing Policy Engine
// ============================================================================

export interface TaskRoutingInput {
  taskId: string;
  projectRoot: string;
  prompt: string;
  classification?: TaskClassification;
  requestedTarget?: ExecutionTarget | 'cloud:jules';
  localQuotaExhausted?: boolean;
  vault?: CredentialVault;
  julesClient?: JulesApiClient;
  store?: Store;
}

export interface RoutingDecision {
  target: 'local' | 'cloud';
  worker: WorkerIdentity;
  reason: string;
  preflightOk?: boolean;
  fallbackAvailable: boolean;
  error?: string;
}

export async function routeTask(input: TaskRoutingInput): Promise<RoutingDecision> {
  const {
    taskId,
    projectRoot,
    classification,
    requestedTarget = 'auto',
    vault,
    julesClient,
    store,
  } = input;

  // 1. Explicit Local Target
  if (requestedTarget === 'local') {
    const decision: RoutingDecision = {
      target: 'local',
      worker: 'antigravity',
      reason: 'User explicitly requested local execution with Antigravity.',
      fallbackAvailable: false,
    };
    logRoutingEvent(store, taskId, decision);
    return decision;
  }

  // 2. Explicit Cloud Target
  if (requestedTarget === 'cloud' || requestedTarget === 'cloud:jules') {
    const preflight = await runJulesPreflight({
      taskId,
      projectRoot,
      vault,
      julesClient,
    });

    if (!preflight.ok) {
      const decision: RoutingDecision = {
        target: 'cloud',
        worker: 'jules',
        preflightOk: false,
        reason: preflight.reason || 'Jules cloud preflight check failed.',
        fallbackAvailable: true,
        error: preflight.reason,
      };
      logRoutingEvent(store, taskId, decision);
      return decision;
    }

    const decision: RoutingDecision = {
      target: 'cloud',
      worker: 'jules',
      preflightOk: true,
      reason: 'User explicitly requested Google Jules cloud execution.',
      fallbackAvailable: true,
    };
    logRoutingEvent(store, taskId, decision);
    return decision;
  }

  // 3. Auto-Routing Decision Matrix

  // 3a. Read-only queries start with the local model.
  if (classification && (!classification.mutating || classification.type === 'question')) {
    const decision: RoutingDecision = {
      target: 'local',
      worker: 'gemma',
      reason: decideFreeFirstRoute(classification, input.prompt, { julesReady: false }).reason,
      fallbackAvailable: false,
    };
    logRoutingEvent(store, taskId, decision);
    return decision;
  }

  if (classification && isGemmaMicroEditCandidate(classification, input.prompt)) {
    const decision: RoutingDecision = { target: 'local', worker: 'gemma', reason: decideFreeFirstRoute(classification, input.prompt, { julesReady: false }).reason, fallbackAvailable: true };
    logRoutingEvent(store, taskId, decision);
    return decision;
  }

  // 3b. Check Jules credential availability (or provided client)
  const v = vault ?? new CredentialVault();
  const hasClient = Boolean(julesClient);
  const { apiKey } = hasClient ? { apiKey: 'configured' } : resolveJulesApiKey(v);
  if (!apiKey) {
    const decision: RoutingDecision = {
      target: 'local',
      worker: 'antigravity',
      reason: 'JULES_API_KEY is not configured; routing to local Antigravity.',
      fallbackAvailable: false,
    };
    logRoutingEvent(store, taskId, decision);
    return decision;
  }

  // 3c. Check Git & worktree preflight
  const preflight = await runJulesPreflight({
    taskId,
    projectRoot,
    vault: v,
    julesClient,
  });

  if (!preflight.ok) {
    const decision: RoutingDecision = {
      target: 'local',
      worker: 'antigravity',
      reason: `Cloud preflight constraints not met (${preflight.reason}); falling back to local Antigravity.`,
      fallbackAvailable: false,
    };
    logRoutingEvent(store, taskId, decision);
    return decision;
  }

  // 3d. All eligible standard/deep mutations prefer Jules. Quota telemetry is display-only.
  if (classification?.mutating) {
    const decision: RoutingDecision = {
      target: 'cloud',
      worker: 'jules',
      preflightOk: true,
      reason: decideFreeFirstRoute(classification, input.prompt, { julesReady: true }).reason,
      fallbackAvailable: true,
    };
    logRoutingEvent(store, taskId, decision);
    return decision;
  }

  // 3e. Missing classification cannot be delegated safely.
  const decision: RoutingDecision = {
    target: 'local',
    worker: 'antigravity',
    reason: 'Standard complexity task routed to local Antigravity for fast interactive pair programming.',
    fallbackAvailable: true,
  };
  logRoutingEvent(store, taskId, decision);
  return decision;
}

function logRoutingEvent(store: Store | undefined, taskId: string, decision: RoutingDecision) {
  if (!store || !taskId) return;
  store.addEvent(taskId, 'orchestra', 'task.routed', {
    target: decision.target,
    worker: decision.worker,
    reason: decision.reason,
    preflightOk: decision.preflightOk,
    fallbackAvailable: decision.fallbackAvailable,
  });
}
