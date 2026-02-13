import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createLogger } from '@jonas/shared/utils';

const log = createLogger('skill-crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

interface VaultFile {
  encrypted: boolean;
  entries: Record<string, string | EncryptedPayload>;
}

/** Manages per-skill encrypted key/value storage (API keys, tokens, etc.) */
export class SkillCryptoStore {
  private masterKey: Buffer | null;

  constructor() {
    const keyHex = process.env.SKILLS_ENCRYPTION_KEY;
    if (keyHex && keyHex.length === 64) {
      this.masterKey = Buffer.from(keyHex, 'hex');
    } else {
      this.masterKey = null;
      if (keyHex) {
        log.warn('SKILLS_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Falling back to plaintext.');
      } else {
        log.warn('SKILLS_ENCRYPTION_KEY not set. Skill values stored in plaintext.');
      }
    }
  }

  private encrypt(value: string): EncryptedPayload {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey!, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    return {
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      data: encrypted.toString('hex'),
    };
  }

  private decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(
      ALGORITHM,
      this.masterKey!,
      Buffer.from(payload.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
    return decipher.update(payload.data, 'hex', 'utf-8') + decipher.final('utf-8');
  }

  private filePath(skillDir: string): string {
    return this.masterKey
      ? `${skillDir}/vault.enc`
      : `${skillDir}/vault.json`;
  }

  private async load(skillDir: string): Promise<Record<string, string>> {
    for (const path of [`${skillDir}/vault.enc`, `${skillDir}/vault.json`]) {
      try {
        const raw = await readFile(path, 'utf-8');
        const file: VaultFile = JSON.parse(raw);
        const result: Record<string, string> = {};

        for (const [key, val] of Object.entries(file.entries)) {
          if (file.encrypted && typeof val === 'object') {
            if (!this.masterKey) {
              log.warn({ skillDir, key }, 'Cannot decrypt value without master key');
              continue;
            }
            result[key] = this.decrypt(val as EncryptedPayload);
          } else {
            result[key] = val as string;
          }
        }
        return result;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return {};
  }

  private async save(skillDir: string, entries: Record<string, string>): Promise<void> {
    const encrypted = !!this.masterKey;
    const file: VaultFile = { encrypted, entries: {} };

    for (const [key, val] of Object.entries(entries)) {
      file.entries[key] = encrypted ? this.encrypt(val) : val;
    }

    const path = this.filePath(skillDir);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
    await rename(tmp, path);

    // Clean up the other format if it exists
    const otherPath = encrypted
      ? `${skillDir}/vault.json`
      : `${skillDir}/vault.enc`;
    await unlink(otherPath).catch(() => {});
  }

  async getAll(skillDir: string): Promise<Record<string, string>> {
    return this.load(skillDir);
  }

  async set(skillDir: string, key: string, value: string): Promise<void> {
    const entries = await this.load(skillDir);
    entries[key] = value;
    await this.save(skillDir, entries);
    log.info({ skillDir, key }, 'Value stored');
  }

  async remove(skillDir: string, key: string): Promise<void> {
    const entries = await this.load(skillDir);
    delete entries[key];
    await this.save(skillDir, entries);
    log.info({ skillDir, key }, 'Value removed');
  }

  async getEnv(skillDir: string): Promise<Record<string, string>> {
    return this.load(skillDir);
  }

  async getKeys(skillDir: string): Promise<string[]> {
    const entries = await this.load(skillDir);
    return Object.keys(entries);
  }
}
