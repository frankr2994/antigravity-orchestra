import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  CredentialVault,
  CredentialVaultCorruptError,
} from '../dist-server/infrastructure/security/vault.js';
import {
  maskApiKey,
  resolveJulesApiKey,
  getJulesCredentialStatus,
  validateJulesApiKey,
} from '../dist-server/providers/jules/credentials.js';

const testProtector = {
  scheme: 'windows-dpapi-current-user',
  protect: (plaintext) => Buffer.from(plaintext).reverse(),
  unprotect: (ciphertext) => Buffer.from(ciphertext).reverse(),
};

// ============================================================================
// Phase 7 Jules Credential & Vault Security Test Suite
// ============================================================================

test('Phase 7 Credentials — maskApiKey produces secure previews', () => {
  assert.equal(maskApiKey(null), '');
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('12345'), '****');

  const key = 'AIzaSy1234567890abcdefghijklmnopqrstuvwxyz';
  const masked = maskApiKey(key);
  assert.ok(masked.startsWith('AIza'));
  assert.ok(masked.endsWith('wxyz'));
  assert.ok(!masked.includes('1234567890'));
  assert.equal(masked.length, key.length);
});

test('Phase 7 Credentials — CredentialVault delegates encryption to an OS credential protector', () => {
  const vaultPath = join(tmpdir(), `orchestra-vault-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const vault = new CredentialVault(vaultPath, testProtector);
    vault.setSecret('jules_api_key', 'AIzaSySecretApiKey123456');

    assert.equal(vault.getSecret('jules_api_key'), 'AIzaSySecretApiKey123456');
    assert.equal(vault.hasSecret('jules_api_key'), true);

    // Verify ciphertext on disk does NOT contain plaintext secret
    const rawFile = readFileSync(vaultPath, 'utf-8');
    assert.ok(!rawFile.includes('AIzaSySecretApiKey123456'), 'Plaintext API key must never appear in raw vault file');
    const parsed = JSON.parse(rawFile);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.protection, 'windows-dpapi-current-user');
    assert.ok(parsed.ciphertext);

    // Removal
    vault.removeSecret('jules_api_key');
    assert.equal(vault.getSecret('jules_api_key'), null);
    assert.equal(vault.hasSecret('jules_api_key'), false);
  } finally {
    try { rmSync(vaultPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Phase 7 Credentials — Resolution priority (process.env > vault > none)', () => {
  const vaultPath = join(tmpdir(), `orchestra-prio-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const originalEnv = process.env.JULES_API_KEY;
  try {
    delete process.env.JULES_API_KEY;
    const vault = new CredentialVault(vaultPath, testProtector);

    // 1. None
    const resNone = resolveJulesApiKey(vault);
    assert.equal(resNone.apiKey, null);
    assert.equal(resNone.source, 'none');

    // 2. Vault configured
    vault.setSecret('jules_api_key', 'vault-secret-key-1234');
    const resVault = resolveJulesApiKey(vault);
    assert.equal(resVault.apiKey, 'vault-secret-key-1234');
    assert.equal(resVault.source, 'vault');

    const statusVault = getJulesCredentialStatus(vault);
    assert.equal(statusVault.configured, true);
    assert.equal(statusVault.source, 'vault');
    assert.ok(!statusVault.masked.includes('vault-secret-key-1234'), 'Status must only expose masked preview');

    // 3. Env takes precedence over vault
    process.env.JULES_API_KEY = 'env-secret-key-5678';
    const resEnv = resolveJulesApiKey(vault);
    assert.equal(resEnv.apiKey, 'env-secret-key-5678');
    assert.equal(resEnv.source, 'env');

    const statusEnv = getJulesCredentialStatus(vault);
    assert.equal(statusEnv.source, 'env');
  } finally {
    if (originalEnv) process.env.JULES_API_KEY = originalEnv;
    else delete process.env.JULES_API_KEY;
    try { rmSync(vaultPath, { force: true }); } catch { /* Windows file lock */ }
  }
});

test('Stage A Credentials — legacy vault migrates only after verified decryption and corruption fails closed', () => {
  const vaultPath = join(tmpdir(), `orchestra-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const username = userInfo().username;
    const identity = `${hostname()}:${username}:${process.env.USERPROFILE || process.env.HOME || ''}`;
    const key = scryptSync(identity, 'orchestra-vault-key-salt', 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify({ jules_api_key: 'legacy-secret' }), 'utf8')),
      cipher.final(),
    ]);
    writeFileSync(vaultPath, JSON.stringify({
      version: 1,
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    }));

    const vault = new CredentialVault(vaultPath, testProtector);
    assert.equal(vault.getSecret('jules_api_key'), 'legacy-secret');
    const migrated = JSON.parse(readFileSync(vaultPath, 'utf8'));
    assert.equal(migrated.version, 2);
    assert.ok(!readFileSync(vaultPath, 'utf8').includes('legacy-secret'));

    writeFileSync(vaultPath, '{"version":2,"protection":"windows-dpapi-current-user","ciphertext":"%%%"}');
    assert.throws(() => vault.getSecret('jules_api_key'), CredentialVaultCorruptError);
  } finally {
    rmSync(vaultPath, { force: true });
  }
});

test('Phase 7 Credentials — validateJulesApiKey performs live/mocked source check without creating sessions', async () => {
  const mockSuccessFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ sources: [{ name: 'sources/github/owner/repo' }] }),
  });

  const validRes = await validateJulesApiKey('valid-key', mockSuccessFetch);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.status, 'valid');
  assert.equal(validRes.sourceCount, 1);

  const mockFailFetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({ error: { message: 'Invalid API Key' } }),
  });

  const invalidRes = await validateJulesApiKey('invalid-key', mockFailFetch);
  assert.equal(invalidRes.valid, false);
  assert.equal(invalidRes.status, 'invalid');
  assert.equal(invalidRes.error, 'The Jules API key was rejected.');

  const reflectedSecret = 'arbitrary-secret-value';
  const reflectionFetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({ error: { message: `Rejected ${reflectedSecret}` } }),
  });
  const reflectedResult = await validateJulesApiKey(reflectedSecret, reflectionFetch);
  assert.equal(JSON.stringify(reflectedResult).includes(reflectedSecret), false);
});
