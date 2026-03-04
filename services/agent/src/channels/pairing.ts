import { readFile, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { createLogger } from '@jonas/shared/utils';

const log = createLogger('channel-pairing');

interface PairingStateEntry {
  paired: boolean;
  pairedAt?: string;
  challengeCode?: string;
  challengeExpiresAt?: string;
  lastInitAt?: string;
}

interface PairingStateFile {
  channels: Record<string, PairingStateEntry>;
}

export class ChannelPairingService {
  private readonly stateFile: string;
  private state: PairingStateFile = { channels: {} };
  private readonly requiredChannels: Set<string>;
  private readonly requireManagedChannels: boolean;

  constructor(stateFile = '/data/channel-pairings.json') {
    this.stateFile = stateFile;
    const enforced = (process.env.PAIRING_ENFORCE_CHANNELS ?? 'gateway')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    this.requiredChannels = new Set(enforced);
    this.requireManagedChannels = (process.env.PAIRING_REQUIRE_MANAGED_CHANNELS ?? 'true') === 'true';
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as PairingStateFile;
      this.state = {
        channels: parsed.channels ?? {},
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err }, 'Failed to read pairing state, using defaults');
      }
      this.state = { channels: {} };
    }
  }

  private async save(): Promise<void> {
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  isRequired(channelType: string): boolean {
    if (this.requiredChannels.has(channelType)) return true;
    if (!this.requireManagedChannels) return false;
    return channelType.startsWith('channel:');
  }

  getStatus(channelType: string): { required: boolean; paired: boolean; pairedAt?: string; challengeExpiresAt?: string } {
    const entry = this.state.channels[channelType];
    return {
      required: this.isRequired(channelType),
      paired: entry?.paired ?? false,
      pairedAt: entry?.pairedAt,
      challengeExpiresAt: entry?.challengeExpiresAt,
    };
  }

  isPaired(channelType: string): boolean {
    const entry = this.state.channels[channelType];
    return entry?.paired ?? false;
  }

  async init(channelType: string, ttlMinutes = 10): Promise<{ channelType: string; code: string; expiresAt: string }> {
    const now = Date.now();
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();

    const current = this.state.channels[channelType] ?? { paired: false };
    this.state.channels[channelType] = {
      ...current,
      challengeCode: code,
      challengeExpiresAt: expiresAt,
      lastInitAt: new Date(now).toISOString(),
    };

    await this.save();
    return { channelType, code, expiresAt };
  }

  async confirm(channelType: string, code: string): Promise<boolean> {
    const entry = this.state.channels[channelType];
    if (!entry?.challengeCode || !entry.challengeExpiresAt) return false;

    const notExpired = Date.now() <= new Date(entry.challengeExpiresAt).getTime();
    if (!notExpired) return false;
    if (entry.challengeCode !== code) return false;

    this.state.channels[channelType] = {
      paired: true,
      pairedAt: new Date().toISOString(),
    };

    await this.save();
    return true;
  }

  async revoke(channelType: string): Promise<void> {
    this.state.channels[channelType] = {
      paired: false,
    };

    await this.save();
  }
}
