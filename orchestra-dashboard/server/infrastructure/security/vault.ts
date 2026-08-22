import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { config } from '../../config.js';

// ============================================================================
// Orchestra Security: Protected Encrypted Credential Vault
// ============================================================================

export interface VaultPayload {
  version: number;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class CredentialVault {
  readonly filePath: string;
  private readonly derivedKey: Buffer;

  constructor(filePath = `${config.dataDir}/vault.enc.json`) {
    this.filePath = filePath;

    // Derive machine and user-bound key
    let userIdentifier = '';
    try {
      userIdentifier = userInfo().username;
    } catch {
      userIdentifier = process.env.USERNAME || process.env.USER || 'default-user';
    }
    const machineIdentifier = `${hostname()}:${userIdentifier}:${process.env.USERPROFILE || process.env.HOME || ''}`;
    this.derivedKey = scryptSync(machineIdentifier, 'orchestra-vault-key-salt', 32);
  }

  private loadAll(): Record<string, string> {
    if (!existsSync(this.filePath)) {
      return {};
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const payload = JSON.parse(raw) as VaultPayload;
      if (payload.version !== 1 || !payload.iv || !payload.authTag || !payload.ciphertext) {
        return {};
      }

      const iv = Buffer.from(payload.iv, 'hex');
      const authTag = Buffer.from(payload.authTag, 'hex');
      const decipher = createDecipheriv('aes-256-gcm', this.derivedKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf-8');
      decrypted += decipher.final('utf-8');

      return JSON.parse(decrypted) as Record<string, string>;
    } catch {
      console.warn('Failed to decrypt vault contents (vault may be from another machine/user). Resetting vault.');
      return {};
    }
  }

  private saveAll(data: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.derivedKey, iv);
    const plaintext = JSON.stringify(data);

    let ciphertext = cipher.update(plaintext, 'utf-8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    const payload: VaultPayload = {
      version: 1,
      iv: iv.toString('hex'),
      authTag,
      ciphertext,
    };

    writeFileSync(this.filePath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  getSecret(key: string): string | null {
    const data = this.loadAll();
    return data[key] ?? null;
  }

  setSecret(key: string, value: string): void {
    const data = this.loadAll();
    data[key] = value;
    this.saveAll(data);
  }

  removeSecret(key: string): void {
    const data = this.loadAll();
    if (key in data) {
      delete data[key];
      this.saveAll(data);
    }
  }

  hasSecret(key: string): boolean {
    const data = this.loadAll();
    return Boolean(data[key]);
  }
}
