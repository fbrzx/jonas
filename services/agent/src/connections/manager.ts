import { createLogger } from '@jonas/shared/utils';
import type { OAuthFlowConfig } from '@jonas/shared/types';
import type { SkillCryptoStore } from '../skills/crypto-store.js';
import type { OAuthProviderStore } from '../oauth/provider-store.js';

const log = createLogger('connection-manager');

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  obtained_at?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
}

interface ConnectionInfo {
  entityDir: string;
  secretKey: string;
  provider: string;
  connected: boolean;
  expiresAt?: number;
  hasRefreshToken: boolean;
}

export class ConnectionManager {
  private cryptoStore: SkillCryptoStore;
  private providerStore: OAuthProviderStore;

  constructor(cryptoStore: SkillCryptoStore, providerStore: OAuthProviderStore) {
    this.cryptoStore = cryptoStore;
    this.providerStore = providerStore;
  }

  /**
   * Get a valid access token, refreshing if it expires within REFRESH_BUFFER_MS.
   * Returns null if no token is stored or provider credentials are missing.
   */
  async getValidToken(
    entityDir: string,
    secretKey: string,
    flowConfig: OAuthFlowConfig,
  ): Promise<string | null> {
    const all = await this.cryptoStore.getAll(entityDir);
    const raw = all[secretKey];
    if (!raw) return null;

    let token: StoredToken;
    try {
      token = JSON.parse(raw) as StoredToken;
    } catch {
      // Not a JSON token object — treat as plain string (legacy)
      return raw;
    }

    if (!token.access_token) return null;

    // Check expiry
    if (token.expires_in && token.obtained_at) {
      const expiresAt = token.obtained_at + token.expires_in * 1000;
      const needsRefresh = Date.now() > expiresAt - REFRESH_BUFFER_MS;

      if (!needsRefresh) {
        return token.access_token;
      }

      // Attempt refresh
      if (token.refresh_token) {
        const refreshed = await this.refreshToken(entityDir, secretKey, token, flowConfig);
        if (refreshed) return refreshed;
      }
    }

    // No expiry info or couldn't refresh — return whatever we have
    return token.access_token;
  }

  private async refreshToken(
    entityDir: string,
    secretKey: string,
    token: StoredToken,
    flowConfig: OAuthFlowConfig,
  ): Promise<string | null> {
    try {
      const creds = await this.resolveCredentials(entityDir, secretKey, flowConfig.provider);
      if (!creds) {
        log.warn({ entityDir, secretKey }, 'Cannot refresh: no provider credentials found');
        return null;
      }

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token!,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (flowConfig.provider === 'github') {
        headers['Accept'] = 'application/json';
      }

      const res = await fetch(creds.tokenEndpoint, {
        method: 'POST',
        headers,
        body: body.toString(),
      });

      if (!res.ok) {
        const text = await res.text();
        log.error({ status: res.status, body: text, entityDir, secretKey }, 'Token refresh failed');
        return null;
      }

      const newTokenData = await res.json() as StoredToken;

      // Merge: keep existing refresh_token if new one not provided (some providers don't re-issue it)
      const updated: StoredToken = {
        ...token,
        ...newTokenData,
        obtained_at: Date.now(),
        refresh_token: newTokenData.refresh_token ?? token.refresh_token,
      };

      await this.cryptoStore.set(entityDir, secretKey, JSON.stringify(updated));

      log.info({ entityDir, secretKey }, 'Token refreshed successfully');
      return updated.access_token;
    } catch (err) {
      log.error({ err, entityDir, secretKey }, 'Error refreshing token');
      return null;
    }
  }

  private async resolveCredentials(
    entityDir: string,
    secretKey: string,
    provider: string,
  ): Promise<{ clientId: string; clientSecret: string; tokenEndpoint: string } | null> {
    // Check inline per-entity credentials (same pattern as skills)
    const all = await this.cryptoStore.getAll(entityDir);
    const inlineClientId = all[`__oauth_${secretKey}_client_id`];
    const inlineClientSecret = all[`__oauth_${secretKey}_client_secret`];

    const providerConfig = this.providerStore.get(provider);

    if (inlineClientId && inlineClientSecret) {
      if (!providerConfig) return null;
      return {
        clientId: inlineClientId,
        clientSecret: inlineClientSecret,
        tokenEndpoint: providerConfig.tokenEndpoint,
      };
    }

    // Fall back to global provider store
    if (!providerConfig?.clientId || !providerConfig?.clientSecret) return null;
    return {
      clientId: providerConfig.clientId,
      clientSecret: providerConfig.clientSecret,
      tokenEndpoint: providerConfig.tokenEndpoint,
    };
  }

  /**
   * Refresh all OAuth tokens for an entity before it starts.
   */
  async refreshForEntity(
    entityDir: string,
    oauth: Record<string, OAuthFlowConfig>,
  ): Promise<void> {
    for (const [secretKey, flowConfig] of Object.entries(oauth)) {
      await this.getValidToken(entityDir, secretKey, flowConfig);
    }
  }

  /**
   * Background sweep — refresh all entities.
   */
  async refreshAll(
    entities: Array<{ dir: string; oauth?: Record<string, OAuthFlowConfig> }>,
  ): Promise<void> {
    for (const entity of entities) {
      if (!entity.oauth) continue;
      try {
        await this.refreshForEntity(entity.dir, entity.oauth);
      } catch (err) {
        log.error({ err, dir: entity.dir }, 'Error refreshing entity tokens');
      }
    }
  }

  /**
   * List connection status for all entities.
   */
  async getConnectionStatus(
    entities: Array<{
      dir: string;
      name: string;
      secretKey: string;
      oauth?: Record<string, OAuthFlowConfig>;
    }>,
  ): Promise<ConnectionInfo[]> {
    const result: ConnectionInfo[] = [];

    for (const entity of entities) {
      if (!entity.oauth) continue;

      for (const [secretKey, flowConfig] of Object.entries(entity.oauth)) {
        const all = await this.cryptoStore.getAll(entity.dir);
        const raw = all[secretKey];

        if (!raw) {
          result.push({
            entityDir: entity.dir,
            secretKey,
            provider: flowConfig.provider,
            connected: false,
            hasRefreshToken: false,
          });
          continue;
        }

        let token: StoredToken;
        let hasRefreshToken = false;
        let expiresAt: number | undefined;

        try {
          token = JSON.parse(raw) as StoredToken;
          hasRefreshToken = !!token.refresh_token;
          if (token.expires_in && token.obtained_at) {
            expiresAt = token.obtained_at + token.expires_in * 1000;
          }
        } catch {
          // Plain string token
        }

        result.push({
          entityDir: entity.dir,
          secretKey,
          provider: flowConfig.provider,
          connected: true,
          expiresAt,
          hasRefreshToken,
        });
      }
    }

    return result;
  }
}
