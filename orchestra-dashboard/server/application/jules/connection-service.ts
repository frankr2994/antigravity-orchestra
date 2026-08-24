import type { Store } from '../../db.js';
import { CredentialVault } from '../../infrastructure/security/vault.js';
import { JulesApiClient } from '../../providers/jules/client.js';
import {
  getJulesCredentialStatus, resolveJulesApiKey, validateJulesApiKey,
  type JulesCredentialValidationResult,
} from '../../providers/jules/credentials.js';
import { discoverJulesSource } from '../../providers/jules/source-discovery.js';
import { ApplicationError } from '../errors.js';
import { config, hasJulesCapability, type JulesRolloutStage, parseJulesRolloutStage } from '../../config.js';
import type { JulesQuotaPlan, JulesSettingsPatch } from './requests.js';

const ENABLED_SETTING = 'jules.enabled';
const STAGE_SETTING = 'jules.rollout_stage';
const QUOTA_PLAN_SETTING = 'jules.quota_plan';
const QUOTA_LIMIT_SETTING = 'jules.rolling_24_hour_limit';

export interface JulesRuntimeSettings {
  enabled: boolean;
  rolloutStage: JulesRolloutStage;
  quotaPlan: JulesQuotaPlan | null;
  rolling24HourLimit: number | null;
}

export class JulesConnectionService {
  constructor(
    private readonly store: Store | undefined,
    readonly vault: CredentialVault,
    private readonly injectedClient?: JulesApiClient,
  ) {}

  credentialStatus() { return getJulesCredentialStatus(this.vault); }
  runtimeSettings(): JulesRuntimeSettings {
    const storedEnabled = this.store?.manager.settings.get(ENABLED_SETTING);
    const enabled = storedEnabled === null || storedEnabled === undefined
      ? config.jules.enabled
      : storedEnabled === 'true';
    const configuredStage = this.store?.manager.settings.get(STAGE_SETTING);
    const fallback = config.jules.rolloutStage === 'off' ? 'auto' : config.jules.rolloutStage;
    const rolloutStage = parseJulesRolloutStage(configuredStage ?? fallback);
    const rawPlan = this.store?.manager.settings.get(QUOTA_PLAN_SETTING);
    const quotaPlan = rawPlan && ['free', 'pro', 'ultra', 'custom'].includes(rawPlan) ? rawPlan as JulesQuotaPlan : null;
    const rawLimit = this.store?.manager.settings.get(QUOTA_LIMIT_SETTING);
    const parsedLimit = Number(rawLimit);
    const rolling24HourLimit = quotaPlan && Number.isSafeInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 10_000 ? parsedLimit : null;
    return { enabled, rolloutStage: enabled ? rolloutStage : 'off', quotaPlan, rolling24HourLimit };
  }
  setRuntimeEnabled(enabled: boolean): JulesRuntimeSettings {
    return this.setRuntimeSettings({ enabled });
  }
  setRuntimeSettings(patch: JulesSettingsPatch): JulesRuntimeSettings {
    if (!this.store) throw new ApplicationError('STORE_UNAVAILABLE', 'Database store is unavailable.', 503);
    const current = this.runtimeSettings();
    const nextPlan = patch.quotaPlan ?? current.quotaPlan;
    const nextLimit = patch.rolling24HourLimit ?? current.rolling24HourLimit;
    if (patch.enabled === true && (!nextPlan || !nextLimit)) {
      throw new ApplicationError('JULES_QUOTA_PLAN_REQUIRED', 'Choose a Jules quota plan before enabling Jules.');
    }
    this.store.manager.transaction(() => {
      if (patch.quotaPlan) this.store!.manager.settings.set(QUOTA_PLAN_SETTING, patch.quotaPlan);
      if (patch.rolling24HourLimit !== undefined) this.store!.manager.settings.set(QUOTA_LIMIT_SETTING, String(patch.rolling24HourLimit));
      if (patch.enabled !== undefined) this.store!.manager.settings.set(ENABLED_SETTING, String(patch.enabled));
      if (!this.store!.manager.settings.get(STAGE_SETTING)) this.store!.manager.settings.set(STAGE_SETTING, 'auto');
    });
    return this.runtimeSettings();
  }
  hasCapability(required: JulesRolloutStage): boolean {
    return hasJulesCapability(this.runtimeSettings().rolloutStage, required);
  }
  async validateCredential(apiKey?: string): Promise<JulesCredentialValidationResult> {
    const selected = apiKey?.trim() || resolveJulesApiKey(this.vault).apiKey;
    if (!selected) throw new ApplicationError('JULES_CREDENTIAL_MISSING', 'No Jules API key is configured.');
    return validateJulesApiKey(selected);
  }
  async saveCredential(apiKey: string, validate: boolean) {
    if (process.env.JULES_API_KEY?.trim()) {
      throw new ApplicationError('JULES_CREDENTIAL_ENV_MANAGED', 'The active Jules API key is managed by the environment.', 409);
    }
    if (validate) {
      const result = await validateJulesApiKey(apiKey);
      if (!result.valid) throw new ApplicationError(`JULES_CREDENTIAL_${result.status.toUpperCase()}`, result.error ?? 'Jules credential validation failed.');
    }
    this.vault.setSecret('jules_api_key', apiKey);
    return this.credentialStatus();
  }
  clearCredential() {
    if (process.env.JULES_API_KEY?.trim()) {
      throw new ApplicationError('JULES_CREDENTIAL_ENV_MANAGED', 'The active Jules API key is managed by the environment.', 409);
    }
    this.vault.removeSecret('jules_api_key');
    return this.credentialStatus();
  }
  client(): JulesApiClient {
    if (this.injectedClient) return this.injectedClient;
    const apiKey = resolveJulesApiKey(this.vault).apiKey;
    if (!apiKey) throw new ApplicationError('JULES_CREDENTIAL_MISSING', 'No Jules API key is configured.');
    return new JulesApiClient({ apiKey, timeoutMs: 15_000 });
  }
  async discoverProjectSource(projectId: string) {
    if (!this.store) throw new ApplicationError('STORE_UNAVAILABLE', 'Database store is unavailable.', 503);
    const project = this.store.getProject(projectId);
    if (!project) throw new ApplicationError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    return discoverJulesSource(project.root, { vault: this.vault, julesClient: this.injectedClient });
  }
}
