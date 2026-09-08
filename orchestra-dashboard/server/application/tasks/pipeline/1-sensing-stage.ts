import { senseEnvironment, type SystemCapabilities } from '../../capabilities/environment-sensor.js';
import { selectModels, resolveAntigravityModel } from '../../routing/model-policy.js';
import { getGitStatus } from '../../../git.js';
import { isOrchestraInternalPath } from '../../../projects.js';
import type { ModelSelection, Project, TaskClassification } from '../../../types.js';
import type { Store } from '../../../db.js';

export interface SensingStageResult {
  capabilities: SystemCapabilities;
  models: ModelSelection;
  isBaselineRequired: boolean;
}

/**
 * Stage 1: Dynamic Sensing & Preflight Validation
 * Discovers live system capabilities, checks repository cleanliness,
 * and initializes model selections based on real-time quotas.
 */
export async function runSensingStage(input: {
  taskId: string;
  project: Project;
  classification: TaskClassification;
  activeGemmaModel: string;
  antigravityModels: string[];
  recovery: boolean;
  store: Store;
  emit: (agent: any, type: any, payload?: Record<string, unknown>) => void;
  transition: (state: any) => void;
}): Promise<SensingStageResult> {
  // 1. Live Environment & Quota Sensing (Non-blocking, zero hardcoding)
  const capabilities = await senseEnvironment({
    projectRoot: input.project.root,
    projectId: input.project.id,
    store: input.store,
  });

  // 2. Model Selection mapped to live Codex quota
  let models: ModelSelection = {
    ...selectModels(input.classification, input.recovery ? 1 : 0, undefined, capabilities.codex.rollingQuotaRemaining),
    primary: 'antigravity',
    gemma: input.activeGemmaModel,
  };
  const resolved = resolveAntigravityModel(models.antigravity, input.antigravityModels);
  models = { ...models, antigravity: resolved.model };
  if (resolved.warning) input.emit('antigravity', 'warning', { message: resolved.warning });

  input.store.updateTask(input.taskId, {
    title: input.classification.title,
    classification: JSON.stringify(input.classification),
    models: JSON.stringify(models),
  });

  // 3. Preflight Project & Git Inspection
  input.transition('preflight');
  if (input.project.onboardingStatus === 'scope_warning') {
    throw new Error('The selected directory contains nested Git repositories. Select the specific repository you want the agents to work in.');
  }

  const status = await getGitStatus(input.project.root);
  const projectChanges = status.files.filter((file) => !isOrchestraInternalPath(file.path));

  let isBaselineRequired = false;
  if (input.classification.mutating && status.isGit && projectChanges.length && !input.recovery) {
    isBaselineRequired = true;
    input.transition('baseline_required');
    input.emit('git', 'git.baseline-required', {
      files: projectChanges,
      message: `${projectChanges.length} project file${projectChanges.length === 1 ? ' has' : 's have'} uncommitted changes. Use Commit & Push Changes to commit them.`,
    });
  }

  return { capabilities, models, isBaselineRequired };
}
