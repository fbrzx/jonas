import { createLogger } from '@jonas/shared/utils';
import type { OAuthProvider } from '@jonas/shared/types';
import type { SkillCryptoStore } from '../skills/crypto-store.js';

const log = createLogger('oauth-providers');

const PROVIDER_DIR = '/data/oauth-providers';

const DEFAULT_PROVIDERS: Omit<OAuthProvider, 'clientId' | 'clientSecret'>[] = [
  {
    id: 'google',
    name: 'Google',
    authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
  },
  {
    id: 'github',
    name: 'GitHub',
    authEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
  },
];

export class OAuthProviderStore {
  private providers = new Map<string, OAuthProvider>();
  private cryptoStore: SkillCryptoStore;

  constructor(cryptoStore: SkillCryptoStore) {
    this.cryptoStore = cryptoStore;
  }

  async load(): Promise<void> {
    const stored = await this.cryptoStore.getAll(PROVIDER_DIR);

    // Pre-seed defaults
    for (const def of DEFAULT_PROVIDERS) {
      if (!stored[`${def.id}__meta`]) {
        this.providers.set(def.id, { ...def, clientId: '', clientSecret: '' });
      }
    }

    // Load stored providers from vault entries
    const metaKeys = Object.keys(stored).filter((k) => k.endsWith('__meta'));
    for (const key of metaKeys) {
      try {
        const meta = JSON.parse(stored[key]) as OAuthProvider;
        const id = meta.id;
        this.providers.set(id, {
          ...meta,
          clientId: stored[`${id}__client_id`] ?? '',
          clientSecret: stored[`${id}__client_secret`] ?? '',
        });
      } catch (err) {
        log.warn({ key, err }, 'Failed to parse provider meta');
      }
    }

    log.info({ count: this.providers.size }, 'OAuth providers loaded');
  }

  list(): OAuthProvider[] {
    return [...this.providers.values()].map((p) => ({
      ...p,
      clientSecret: p.clientSecret ? '••••••••' : '',
    }));
  }

  get(id: string): OAuthProvider | undefined {
    return this.providers.get(id);
  }

  isConfigured(id: string): boolean {
    const p = this.providers.get(id);
    return !!p?.clientId && !!p?.clientSecret;
  }

  async upsert(provider: OAuthProvider): Promise<void> {
    this.providers.set(provider.id, provider);

    const meta: Omit<OAuthProvider, 'clientId' | 'clientSecret'> = {
      id: provider.id,
      name: provider.name,
      authEndpoint: provider.authEndpoint,
      tokenEndpoint: provider.tokenEndpoint,
    };

    await this.cryptoStore.set(PROVIDER_DIR, `${provider.id}__meta`, JSON.stringify(meta));
    await this.cryptoStore.set(PROVIDER_DIR, `${provider.id}__client_id`, provider.clientId);
    await this.cryptoStore.set(PROVIDER_DIR, `${provider.id}__client_secret`, provider.clientSecret);

    log.info({ id: provider.id }, 'Provider upserted');
  }

  async remove(id: string): Promise<boolean> {
    if (!this.providers.has(id)) return false;
    this.providers.delete(id);

    await this.cryptoStore.remove(PROVIDER_DIR, `${id}__meta`);
    await this.cryptoStore.remove(PROVIDER_DIR, `${id}__client_id`);
    await this.cryptoStore.remove(PROVIDER_DIR, `${id}__client_secret`);

    log.info({ id }, 'Provider removed');
    return true;
  }
}
