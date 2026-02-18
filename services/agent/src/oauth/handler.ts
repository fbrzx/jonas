import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createLogger } from '@jonas/shared/utils';
import type { OAuthProviderStore } from './provider-store.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ChannelRegistry } from '../channels/registry.js';

const log = createLogger('oauth-handler');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface StatePayload {
  provider: string;
  skillDirName: string; // entity dir name — kept as skillDirName for backward compat
  secretKey: string;
  redirectUri: string;
  nonce: string;
  exp: number;
  entityType?: 'skill' | 'channel';
}

export class OAuthHandler {
  private masterKey: Buffer | null;
  private providerStore: OAuthProviderStore;
  private skillRegistry: SkillRegistry;
  private channelRegistry?: ChannelRegistry;
  private redirectUri: string;

  constructor(opts: {
    providerStore: OAuthProviderStore;
    skillRegistry: SkillRegistry;
    channelRegistry?: ChannelRegistry;
    redirectUri?: string;
  }) {
    const keyHex = process.env.SKILLS_ENCRYPTION_KEY;
    if (keyHex?.length === 64) {
      this.masterKey = Buffer.from(keyHex, 'hex');
    } else {
      this.masterKey = randomBytes(32);
      log.warn('SKILLS_ENCRYPTION_KEY not set — using ephemeral key for OAuth state (tokens will not survive restarts)');
    }
    this.providerStore = opts.providerStore;
    this.skillRegistry = opts.skillRegistry;
    this.channelRegistry = opts.channelRegistry;
    this.redirectUri = opts.redirectUri ?? 'http://localhost:3000/oauth/callback';
  }

  private encryptState(payload: StatePayload): string {
    if (!this.masterKey) throw new Error('Encryption key not configured');
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, data]).toString('base64url');
  }

  private decryptState(token: string): StatePayload {
    if (!this.masterKey) throw new Error('Encryption key not configured');
    const buf = Buffer.from(token, 'base64url');
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
    const data = buf.subarray(IV_LENGTH + 16);

    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(tag);
    const json = decipher.update(data) + decipher.final('utf-8');
    return JSON.parse(json) as StatePayload;
  }

  private async resolveCredentials(
    provider: string,
    entityDirName: string,
    secretKey: string,
    entityType: 'skill' | 'channel' = 'skill',
  ): Promise<{ clientId: string; clientSecret: string; authEndpoint: string; tokenEndpoint: string }> {
    // 1. Check inline per-entity credentials
    const inline = entityType === 'channel' && this.channelRegistry
      ? await this.channelRegistry.getOAuthCredentials(entityDirName, secretKey)
      : await this.skillRegistry.getOAuthCredentials(entityDirName, secretKey);
    const providerConfig = this.providerStore.get(provider);

    if (inline) {
      if (!providerConfig) throw new Error(`Unknown provider: ${provider}`);
      return {
        clientId: inline.clientId,
        clientSecret: inline.clientSecret,
        authEndpoint: providerConfig.authEndpoint,
        tokenEndpoint: providerConfig.tokenEndpoint,
      };
    }

    // 2. Fall back to global provider store
    if (!providerConfig) throw new Error(`Unknown provider: ${provider}`);
    if (!providerConfig.clientId || !providerConfig.clientSecret) {
      throw new Error(`Provider "${provider}" not configured with credentials`);
    }
    return {
      clientId: providerConfig.clientId,
      clientSecret: providerConfig.clientSecret,
      authEndpoint: providerConfig.authEndpoint,
      tokenEndpoint: providerConfig.tokenEndpoint,
    };
  }

  async authorize(opts: {
    provider: string;
    skillDirName: string;
    secretKey: string;
    scopes: string[];
    entityType?: 'skill' | 'channel';
  }): Promise<{ authUrl: string; state: string }> {
    const entityType = opts.entityType ?? 'skill';
    const creds = await this.resolveCredentials(opts.provider, opts.skillDirName, opts.secretKey, entityType);

    const state = this.encryptState({
      provider: opts.provider,
      skillDirName: opts.skillDirName,
      secretKey: opts.secretKey,
      redirectUri: this.redirectUri,
      nonce: randomBytes(16).toString('hex'),
      exp: Date.now() + STATE_TTL_MS,
      entityType,
    });

    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: opts.scopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    const authUrl = `${creds.authEndpoint}?${params.toString()}`;
    log.info({ provider: opts.provider, skill: opts.skillDirName }, 'OAuth authorize URL generated');

    return { authUrl, state };
  }

  async exchange(opts: {
    code: string;
    state: string;
  }): Promise<{ success: boolean; skillDirName: string; secretKey: string; entityType: 'skill' | 'channel' }> {
    const payload = this.decryptState(opts.state);

    if (Date.now() > payload.exp) {
      throw new Error('OAuth state expired');
    }

    const entityType = payload.entityType ?? 'skill';
    const creds = await this.resolveCredentials(payload.provider, payload.skillDirName, payload.secretKey, entityType);

    // Use the redirect_uri from encrypted state to prevent tampering
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: payload.redirectUri,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // GitHub needs Accept: application/json
    if (payload.provider === 'github') {
      headers['Accept'] = 'application/json';
    }

    const res = await fetch(creds.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error({ status: res.status, body: text }, 'Token exchange failed');
      throw new Error(`Token exchange failed: ${res.status}`);
    }

    const tokenData = await res.json() as Record<string, unknown>;

    // Add obtained_at for expiry calculation: obtained_at + expires_in * 1000
    tokenData.obtained_at = Date.now();

    // Store token in the appropriate registry
    if (entityType === 'channel' && this.channelRegistry) {
      await this.channelRegistry.setChannelValue(
        payload.skillDirName,
        payload.secretKey,
        JSON.stringify(tokenData),
      );
    } else {
      const ok = await this.skillRegistry.setSkillValue(
        payload.skillDirName,
        payload.secretKey,
        JSON.stringify(tokenData),
      );
      if (!ok) throw new Error(`Skill "${payload.skillDirName}" not found`);
    }

    log.info(
      { provider: payload.provider, entity: payload.skillDirName, key: payload.secretKey, entityType },
      'OAuth tokens stored',
    );

    return { success: true, skillDirName: payload.skillDirName, secretKey: payload.secretKey, entityType };
  }
}
