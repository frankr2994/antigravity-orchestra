import { CredentialVault } from '../../infrastructure/security/vault.js';
import { JulesApiClient } from './client.js';
import { JulesApiError } from './errors.js';
import { JulesContractError } from './validation.js';

// ============================================================================
// Google Jules Credential Management & Resolution
// ============================================================================

export interface JulesCredentialStatus {
  configured: boolean;
  source: 'env' | 'vault' | 'none';
  masked: string;
}

export type JulesCredentialValidationStatus =
  | 'valid'
  | 'invalid'
  | 'forbidden'
  | 'rate_limited'
  | 'unavailable'
  | 'contract_error';

export interface JulesCredentialValidationResult {
  valid: boolean;
  status: JulesCredentialValidationStatus;
  error?: string;
  sourceCount?: number;
}

export function maskApiKey(key?: string | null): string {
  if (!key || !key.trim()) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '****';
  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}${'*'.repeat(Math.max(4, trimmed.length - 8))}${suffix}`;
}

export function resolveJulesApiKey(vault?: CredentialVault): { apiKey: string | null; source: 'env' | 'vault' | 'none' } {
  // 1. Process environment
  const envKey = process.env.JULES_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, source: 'env' };
  }

  // 2. Encrypted server-side vault
  const v = vault ?? new CredentialVault();
  const vaultKey = v.getSecret('jules_api_key')?.trim();
  if (vaultKey) {
    return { apiKey: vaultKey, source: 'vault' };
  }

  return { apiKey: null, source: 'none' };
}

export function getJulesCredentialStatus(vault?: CredentialVault): JulesCredentialStatus {
  const { apiKey, source } = resolveJulesApiKey(vault);
  if (!apiKey) {
    return {
      configured: false,
      source: 'none',
      masked: '',
    };
  }

  return {
    configured: true,
    source,
    masked: maskApiKey(apiKey),
  };
}

export async function validateJulesApiKey(
  apiKey: string,
  fetchFn?: typeof fetch
): Promise<JulesCredentialValidationResult> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, status: 'invalid', error: 'API key cannot be empty.' };
  }

  try {
    const client = new JulesApiClient({
      apiKey,
      timeoutMs: 10_000,
      maxRetries: 1,
      fetchFn,
    });

    const res = await client.listSources();
    return {
      valid: true,
      status: 'valid',
      sourceCount: res.sources?.length || 0,
    };
  } catch (err: unknown) {
    if (err instanceof JulesContractError) {
      return { valid: false, status: 'contract_error', error: 'Jules returned an incompatible response.' };
    }
    if (err instanceof JulesApiError) {
      if (err.status === 401) return { valid: false, status: 'invalid', error: 'The Jules API key was rejected.' };
      if (err.status === 403) return { valid: false, status: 'forbidden', error: 'The Jules API key lacks repository access.' };
      if (err.status === 429) return { valid: false, status: 'rate_limited', error: 'Jules rate limited credential validation.' };
    }
    return { valid: false, status: 'unavailable', error: 'Jules credential validation is temporarily unavailable.' };
  }
}
