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

const ENABLED_SETTING = 'jules.enabled';
const STAGE_SETTING = 'jules.rollout_stage';

export class JulesConnectionService {
  constructor(
    private readonly store: Store | undefined,
    readonly vault: CredentialVault,
    private readonly injectedClient?: JulesApiClient,
  ) {}

  credentialStatus() { return getJulesCredentialStatus(this.vault); }
  runtimeSettings(): { enabled: boolean; rolloutStage: JulesRolloutStage } {
    const storedEnabled = this.store?.manager.settings.get(ENABLED_SETTING);
    const enabled = storedEnabled === null || storedEnabled === undefined
      ? config.jules.enabled
      : storedEnabled === 'true';
    const configuredStage = this.store?.manager.settings.get(STAGE_SETTING);
    const fallback = config.jules.rolloutStage === 'off' ? 'auto' : config.jules.rolloutStage;
    const rolloutStage = parseJulesRolloutStage(configuredStage ?? fallback);
    return { enabled, rolloutStage: enabled ? rolloutStage : 'off' };
  }
  setRuntimeEnabled(enabled: boolean): { enabled: boolean; rolloutStage: JulesRolloutStage } {
    if (!this.store) throw new ApplicationError('STORE_UNAVAILABLE', 'Database store is unavailable.', 503);
    this.store.manager.settings.set(ENABLED_SETTING, String(enabled));
    if (!this.store.manager.settings.get(STAGE_SETTING)) this.store.manager.settings.set(STAGE_SETTING, 'auto');
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
