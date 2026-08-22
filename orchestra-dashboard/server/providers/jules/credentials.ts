import { CredentialVault } from '../../infrastructure/security/vault.js';
import { JulesApiClient } from './client.js';

// ============================================================================
// Google Jules Credential Management & Resolution
// ============================================================================

export interface JulesCredentialStatus {
  configured: boolean;
  source: 'env' | 'vault' | 'none';
  masked: string;
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
): Promise<{ valid: boolean; error?: string; sourceCount?: number }> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, error: 'API key cannot be empty.' };
  }

  try {
    const client = new JulesApiClient({
      apiKey,
      timeoutMs: 10_000,
      maxRetries: 1,
      fetchFn,
    });

    const sources = await client.listSources();
    return {
      valid: true,
      sourceCount: sources.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      error: message,
    };
  }
}
