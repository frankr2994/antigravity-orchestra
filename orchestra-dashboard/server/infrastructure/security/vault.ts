import { createDecipheriv, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../../config.js';

interface LegacyVaultPayload { version: 1; iv: string; authTag: string; ciphertext: string; }
export interface VaultPayload {
  version: 2;
  protection: 'windows-dpapi-current-user';
  ciphertext: string;
}
export interface CredentialProtector {
  readonly scheme: VaultPayload['protection'];
  protect(plaintext: Buffer): Buffer;
  unprotect(ciphertext: Buffer): Buffer;
}
export class CredentialVaultError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'CredentialVaultError'; }
}
export class CredentialVaultCorruptError extends CredentialVaultError {
  constructor(options?: ErrorOptions) {
    super('Credential vault is corrupt, incompatible, or belongs to another OS user', options);
    this.name = 'CredentialVaultCorruptError';
  }
}

const PROTECT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$encoded = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($encoded)',
  '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
  '$result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($result))',
].join('; ');
const UNPROTECT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$encoded = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($encoded)',
  '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
  '$result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($result))',
].join('; ');

export class WindowsDpapiProtector implements CredentialProtector {
  readonly scheme = 'windows-dpapi-current-user' as const;
  protect(plaintext: Buffer): Buffer { return this.invoke(PROTECT_SCRIPT, plaintext); }
  unprotect(ciphertext: Buffer): Buffer { return this.invoke(UNPROTECT_SCRIPT, ciphertext); }

  private invoke(script: string, input: Buffer): Buffer {
    if (process.platform !== 'win32') {
      throw new CredentialVaultError('Windows DPAPI credential storage is unavailable on this platform');
    }
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: input.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !result.stdout.trim()) {
      throw new CredentialVaultError('Windows DPAPI operation failed', { cause: result.error });
    }
    const output = Buffer.from(result.stdout.trim(), 'base64');
    if (output.length === 0) throw new CredentialVaultError('Windows DPAPI returned an invalid response');
    return output;
  }
}

function isSecretRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, secret]) => key.length > 0 && typeof secret === 'string');
}
function legacyDerivedKey(): Buffer {
  let username = '';
  try { username = userInfo().username; } catch { username = process.env.USERNAME || process.env.USER || 'default-user'; }
  const machineIdentifier = `${hostname()}:${username}:${process.env.USERPROFILE || process.env.HOME || ''}`;
  return scryptSync(machineIdentifier, 'orchestra-vault-key-salt', 32);
}
function decryptLegacy(payload: LegacyVaultPayload): Record<string, string> {
  const decipher = createDecipheriv('aes-256-gcm', legacyDerivedKey(), Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'hex')), decipher.final()]);
  const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
  if (!isSecretRecord(parsed)) throw new TypeError('Legacy vault payload is not a secret record');
  return parsed;
}

export class CredentialVault {
  readonly filePath: string;
  constructor(
    filePath = `${config.dataDir}/vault.enc.json`,
    private readonly protector: CredentialProtector = new WindowsDpapiProtector(),
  ) { this.filePath = filePath; }

  private loadAll(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    try {
      const payload: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (this.isCurrentPayload(payload)) {
        if (payload.protection !== this.protector.scheme) throw new TypeError('Credential protection scheme mismatch');
        const plaintext = this.protector.unprotect(Buffer.from(payload.ciphertext, 'base64'));
        const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
        if (!isSecretRecord(parsed)) throw new TypeError('Vault payload is not a secret record');
        return parsed;
      }
      if (this.isLegacyPayload(payload)) {
        const secrets = decryptLegacy(payload);
        this.saveAll(secrets);
        return secrets;
      }
      throw new TypeError('Unknown credential vault format');
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultCorruptError({ cause: error });
    }
  }

  private saveAll(data: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const ciphertext = this.protector.protect(Buffer.from(JSON.stringify(data), 'utf8'));
    const payload: VaultPayload = { version: 2, protection: this.protector.scheme, ciphertext: ciphertext.toString('base64') };
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
    } finally { rmSync(temporaryPath, { force: true }); }
  }

  private isCurrentPayload(value: unknown): value is VaultPayload {
    const payload = value as Partial<VaultPayload> | null;
    return payload?.version === 2 && payload.protection === 'windows-dpapi-current-user'
      && typeof payload.ciphertext === 'string' && payload.ciphertext.length > 0;
  }
  private isLegacyPayload(value: unknown): value is LegacyVaultPayload {
    const payload = value as Partial<LegacyVaultPayload> | null;
    return payload?.version === 1 && typeof payload.iv === 'string'
      && typeof payload.authTag === 'string' && typeof payload.ciphertext === 'string';
  }
  getSecret(key: string): string | null { return this.loadAll()[key] ?? null; }
  setSecret(key: string, value: string): void {
    if (!key || !value) throw new CredentialVaultError('Credential key and value must not be empty');
    const data = this.loadAll(); data[key] = value; this.saveAll(data);
  }
  removeSecret(key: string): void {
    const data = this.loadAll();
    if (key in data) { delete data[key]; this.saveAll(data); }
  }
  hasSecret(key: string): boolean { return Boolean(this.loadAll()[key]); }
}
