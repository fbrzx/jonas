import { readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import AdmZip from 'adm-zip';
import type {
  PlatformChannel,
  ChannelMetadata,
  ChannelStatus,
  ChannelState,
  ChannelConfig,
  ChannelHandler,
} from '@jonas/shared/types';
import { createLogger } from '@jonas/shared/utils';
import type { SkillCryptoStore } from '../skills/crypto-store.js';
import type { ConnectionManager } from '../connections/manager.js';

const log = createLogger('channels');

interface ChannelStateFile {
  channels: Record<string, { status: ChannelStatus }>;
}

export class ChannelRegistry {
  private channels = new Map<string, PlatformChannel>();
  private handlers = new Map<string, ChannelHandler>();
  private readonly channelsDir: string;
  private readonly stateFile: string;
  private readonly cryptoStore: SkillCryptoStore;
  private readonly connectionManager?: ConnectionManager;

  constructor(cryptoStore: SkillCryptoStore, dataDir = '/data', connectionManager?: ConnectionManager) {
    this.channelsDir = join(dataDir, 'channels');
    this.stateFile = join(dataDir, 'channels.json');
    this.cryptoStore = cryptoStore;
    this.connectionManager = connectionManager;
  }

  async load(): Promise<void> {
    log.info('Loading channels from disk...');

    // Ensure channels directory exists
    if (!existsSync(this.channelsDir)) {
      await mkdir(this.channelsDir, { recursive: true });
      log.info({ channelsDir: this.channelsDir }, 'Created channels directory');
    }

    // Load state file (enabled/disabled status)
    const state = await this.loadState();

    // Scan channels directory
    const entries = await readdir(this.channelsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const channelPath = join(this.channelsDir, entry.name);
      const channelMdPath = join(channelPath, 'channel.md');

      if (!existsSync(channelMdPath)) {
        log.warn({ channel: entry.name }, 'Skipping directory without channel.md');
        continue;
      }

      try {
        const channel = await this.loadChannel(entry.name, channelPath, state);
        this.channels.set(entry.name, channel);
        log.debug({ channel: entry.name }, 'Loaded channel');
      } catch (err) {
        log.error({ channel: entry.name, err }, 'Failed to load channel');
      }
    }

    log.info({ count: this.channels.size }, 'Channels loaded');
  }

  private async loadState(): Promise<ChannelStateFile> {
    if (!existsSync(this.stateFile)) {
      return { channels: {} };
    }

    try {
      const content = await readFile(this.stateFile, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      log.error({ err }, 'Failed to load channel state, using defaults');
      return { channels: {} };
    }
  }

  private async saveState(): Promise<void> {
    const state: ChannelStateFile = { channels: {} };

    for (const [name, channel] of this.channels) {
      state.channels[name] = { status: channel.status };
    }

    await writeFile(this.stateFile, JSON.stringify(state, null, 2));
  }

  private async loadChannel(
    dirName: string,
    channelPath: string,
    state: ChannelStateFile
  ): Promise<PlatformChannel> {
    // Parse channel.md (YAML frontmatter + description)
    const channelMdPath = join(channelPath, 'channel.md');
    const mdContent = await readFile(channelMdPath, 'utf-8');
    const metadata = this.parseChannelMd(mdContent);

    // Load config.json if exists
    let config: ChannelConfig | undefined;
    const configPath = join(channelPath, 'config.json');
    if (existsSync(configPath)) {
      const configContent = await readFile(configPath, 'utf-8');
      config = JSON.parse(configContent);
    }

    // Load secret keys from vault
    const secretKeys = await this.cryptoStore.getKeys(channelPath);

    // Runtime is always Node.js
    const runtime: 'node' = 'node';

    // Get status from state file (default: disabled)
    const status = state.channels[dirName]?.status ?? 'disabled';

    return {
      dirName,
      metadata,
      status,
      state: 'stopped',
      runtime,
      filePath: channelPath,
      loadedAt: new Date().toISOString(),
      config,
      secretKeys,
    };
  }

  private parseChannelMd(content: string): ChannelMetadata {
    // Extract YAML frontmatter between ---
    const match = content.match(/^---\n([\s\S]+?)\n---/);
    if (!match) {
      throw new Error('No YAML frontmatter found in channel.md');
    }

    const yaml = parseYaml(match[1]) as Record<string, unknown>;

    return {
      name: String(yaml.name ?? 'Unnamed'),
      platform: String(yaml.platform ?? 'unknown'),
      version: String(yaml.version ?? '1.0.0'),
      author: String(yaml.author ?? 'unknown'),
      description: String(yaml.description ?? ''),
      mode: yaml.mode as 'webhook' | 'polling' | 'both' | undefined,
    };
  }

  list(): PlatformChannel[] {
    return Array.from(this.channels.values());
  }

  get(name: string): PlatformChannel | null {
    return this.channels.get(name) ?? null;
  }

  async enable(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Channel not found: ${name}`);

    channel.status = 'enabled';
    this.channels.set(name, channel);
    await this.saveState();

    log.info({ channel: name }, 'Channel enabled');
  }

  async disable(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Channel not found: ${name}`);

    // Stop if running
    if (channel.state === 'running') {
      await this.stopChannel(name);
    }

    channel.status = 'disabled';
    this.channels.set(name, channel);
    await this.saveState();

    log.info({ channel: name }, 'Channel disabled');
  }

  async startChannel(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Channel not found: ${name}`);

    if (channel.state === 'running') {
      log.warn({ channel: name }, 'Channel already running');
      return;
    }

    channel.state = 'starting';
    this.channels.set(name, channel);

    try {
      // Refresh OAuth tokens before starting
      if (this.connectionManager && channel.config?.oauth) {
        await this.connectionManager.refreshForEntity(channel.filePath, channel.config.oauth);
      }

      const handler = await this.loadHandler(channel);
      await handler.start();

      this.handlers.set(name, handler);
      channel.state = 'running';
      channel.error = undefined;

      log.info({ channel: name }, 'Channel started');
    } catch (err) {
      channel.state = 'error';
      channel.error = err instanceof Error ? err.message : String(err);
      log.error({ channel: name, err }, 'Failed to start channel');
      throw err;
    } finally {
      this.channels.set(name, channel);
    }
  }

  async stopChannel(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Channel not found: ${name}`);

    if (channel.state !== 'running') {
      log.warn({ channel: name, state: channel.state }, 'Channel not running');
      return;
    }

    const handler = this.handlers.get(name);
    if (handler) {
      try {
        await handler.stop();
      } catch (err) {
        log.error({ channel: name, err }, 'Error stopping channel');
      }
      this.handlers.delete(name);
    }

    channel.state = 'stopped';
    channel.error = undefined;
    this.channels.set(name, channel);

    log.info({ channel: name }, 'Channel stopped');
  }

  async sendMessage(name: string, channelId: string, text: string): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Channel not running: ${name}`);
    }

    await handler.send(channelId, text);
  }

  async handleWebhook(name: string, body: unknown): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Channel not found: ${name}`);
    if (channel.state !== 'running') throw new Error(`Channel not running: ${name}`);
    const handler = this.handlers.get(name);
    if (!handler?.handleWebhook) throw new Error(`Channel does not support webhooks: ${name}`);
    await handler.handleWebhook(body);
  }

  private async loadHandler(channel: PlatformChannel): Promise<ChannelHandler> {
    const jsHandlerPath = join(channel.filePath, 'handler.js');

    // Load secrets
    const secrets = await this.cryptoStore.getAll(channel.filePath);

    // Get config
    const config = channel.config ?? {};

    // Capture channel name for closures
    const channelName = channel.dirName;

    // Create sendToAgent callback
    const sendToAgent = async (message: string, channelId: string): Promise<string> => {
      try {
        const agentToken = (process.env.AGENT_API_TOKEN ?? '').trim();
        const response = await fetch('http://localhost:3001/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(agentToken ? { 'x-agent-token': agentToken } : {}),
          },
          body: JSON.stringify({
            message,
            channelType: `channel:${channelName}`,
            channelId,
            sessionKey: `channel:${channelName}:${channelId}`,
          }),
        });

        const data = (await response.json()) as { response?: string; error?: string };

        // If the API returned an error, throw it
        if (data.error) {
          throw new Error(data.error);
        }

        return data.response ?? 'No response';
      } catch (err) {
        log.error({ err, channel: channelName }, 'Failed to send to agent');
        throw err;
      }
    };

    // Load JavaScript handler
    if (existsSync(jsHandlerPath)) {
      log.info({ channel: channel.dirName }, 'Loading JavaScript handler');

      const moduleUrl = `${pathToFileURL(jsHandlerPath).href}?t=${Date.now()}`;
      const module = await import(moduleUrl);
      if (!module.initialize) {
        throw new Error('Handler must export initialize function');
      }

      return module.initialize(config, secrets, sendToAgent);
    }

    throw new Error(`No handler found at ${jsHandlerPath}`);
  }

  async setChannelValue(name: string, key: string, value: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Channel not found: ${name}`);

    await this.cryptoStore.set(channel.filePath, key, value);

    // Update secret keys list
    channel.secretKeys = await this.cryptoStore.getKeys(channel.filePath);
    this.channels.set(name, channel);

    log.info({ channel: name, key }, 'Channel value set');
  }

  async deleteChannelValue(name: string, key: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Channel not found: ${name}`);

    await this.cryptoStore.remove(channel.filePath, key);

    // Update secret keys list
    channel.secretKeys = await this.cryptoStore.getKeys(channel.filePath);
    this.channels.set(name, channel);

    log.info({ channel: name, key }, 'Channel value deleted');
  }

  async updateConfig(name: string, config: ChannelConfig): Promise<boolean> {
    const channel = this.channels.get(name);
    if (!channel) return false;
    const configPath = join(channel.filePath, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    channel.config = config;
    log.info({ channel: name }, 'Channel config updated');
    return true;
  }

  async delete(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) throw new Error(`Channel not found: ${name}`);

    // Stop if running
    if (channel.state === 'running') {
      await this.stopChannel(name);
    }

    // Delete from disk
    await rm(channel.filePath, { recursive: true, force: true });

    // Remove from registry
    this.channels.delete(name);
    await this.saveState();

    log.info({ channel: name }, 'Channel deleted');
  }

  async setOAuthCredentials(
    dirName: string,
    secretKey: string,
    clientId: string,
    clientSecret: string,
  ): Promise<boolean> {
    const channel = this.channels.get(dirName);
    if (!channel) return false;
    await this.cryptoStore.set(channel.filePath, `__oauth_${secretKey}_client_id`, clientId);
    await this.cryptoStore.set(channel.filePath, `__oauth_${secretKey}_client_secret`, clientSecret);
    channel.secretKeys = await this.cryptoStore.getKeys(channel.filePath);
    this.channels.set(dirName, channel);
    log.info({ channel: dirName, secretKey }, 'Channel OAuth credentials set');
    return true;
  }

  async getOAuthCredentials(
    dirName: string,
    secretKey: string,
  ): Promise<{ clientId: string; clientSecret: string } | null> {
    const channel = this.channels.get(dirName);
    if (!channel) return null;
    const all = await this.cryptoStore.getAll(channel.filePath);
    const clientId = all[`__oauth_${secretKey}_client_id`];
    const clientSecret = all[`__oauth_${secretKey}_client_secret`];
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  }

  /**
   * Update source files for a channel. Writes any provided files to disk,
   * reloads metadata, and restarts the channel if it was running.
   */
  async updateSource(
    name: string,
    opts: { channelMd?: string; handlerJs?: string },
  ): Promise<boolean> {
    const channel = this.channels.get(name);
    if (!channel) return false;

    const wasRunning = channel.state === 'running';

    if (wasRunning) {
      await this.stopChannel(name);
    }

    if (opts.channelMd !== undefined) {
      await writeFile(join(channel.filePath, 'channel.md'), opts.channelMd, 'utf-8');
    }

    if (opts.handlerJs !== undefined) {
      await writeFile(join(channel.filePath, 'handler.js'), opts.handlerJs, 'utf-8');
    }

    // Reload metadata from disk
    const state = await this.loadState();
    const updated = await this.loadChannel(name, channel.filePath, state);
    this.channels.set(name, updated);

    log.info({ channel: name, updatedFiles: Object.keys(opts).filter((k) => opts[k as keyof typeof opts] !== undefined) }, 'Channel source updated');

    if (wasRunning) {
      await this.startChannel(name);
    }

    return true;
  }

  async exportChannel(name: string): Promise<Buffer | null> {
    const channel = this.channels.get(name);
    if (!channel) return null;

    const zip = new AdmZip();

    // Add all files from channel directory EXCEPT vault files (secrets)
    const entries = await readdir(channel.filePath, { withFileTypes: true });

    for (const entry of entries) {
      // Exclude vault files to prevent exporting secrets
      if (entry.name === 'vault.enc' || entry.name === 'vault.json') continue;

      const fullPath = join(channel.filePath, entry.name);

      if (entry.isFile()) {
        zip.addLocalFile(fullPath);
      } else if (entry.isDirectory()) {
        zip.addLocalFolder(fullPath, entry.name);
      }
    }

    return zip.toBuffer();
  }

  async importChannel(zipBuffer: Buffer, overwrite = false): Promise<PlatformChannel> {
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    // Find channel.md to get channel name
    const channelMdEntry = entries.find((e) => e.entryName === 'channel.md');
    if (!channelMdEntry) {
      throw new Error('Invalid channel package: missing channel.md');
    }

    const mdContent = channelMdEntry.getData().toString('utf-8');
    const metadata = this.parseChannelMd(mdContent);
    const channelName = metadata.platform; // Use platform as directory name

    const channelPath = join(this.channelsDir, channelName);

    // Check if exists
    const existingVaultEnc = existsSync(join(channelPath, 'vault.enc')) ? await readFile(join(channelPath, 'vault.enc')) : null;
    const existingVaultJson = existsSync(join(channelPath, 'vault.json')) ? await readFile(join(channelPath, 'vault.json')) : null;

    if (existsSync(channelPath) && !overwrite) {
      throw new Error(`Channel already exists: ${channelName}`);
    }

    // Extract entries manually to guard against Zip Slip
    await mkdir(channelPath, { recursive: true });
    for (const entry of entries) {
      if (entry.isDirectory) continue;

      // Skip vault files (preserve existing secrets)
      if (entry.entryName === 'vault.enc' || entry.entryName === 'vault.json') continue;
      // Skip hidden files and macOS metadata
      if (entry.entryName.startsWith('.') || entry.entryName.includes('/__MACOSX/')) continue;

      const targetPath = join(channelPath, entry.entryName);

      // Block Zip Slip: ensure extracted path stays within channel directory
      if (!targetPath.startsWith(channelPath + '/') && targetPath !== channelPath) {
        throw new Error(`Zip Slip blocked: "${entry.entryName}" escapes the channel directory`);
      }

      await mkdir(join(targetPath, '..'), { recursive: true });
      await writeFile(targetPath, entry.getData());
    }

    // Restore existing vault files (never overwrite secrets)
    if (existingVaultEnc) {
      await writeFile(join(channelPath, 'vault.enc'), existingVaultEnc);
    }
    if (existingVaultJson) {
      await writeFile(join(channelPath, 'vault.json'), existingVaultJson);
    }

    // Load the new channel
    const state = await this.loadState();
    const channel = await this.loadChannel(channelName, channelPath, state);

    this.channels.set(channelName, channel);

    log.info({ channel: channelName }, 'Channel imported');

    return channel;
  }

  async create(
    dirName: string,
    metadata: ChannelMetadata,
    config?: ChannelConfig
  ): Promise<PlatformChannel> {
    const channelPath = join(this.channelsDir, dirName);

    if (existsSync(channelPath)) {
      throw new Error(`Channel already exists: ${dirName}`);
    }

    // Create directory
    await mkdir(channelPath, { recursive: true });

    // Create channel.md
    const channelMd = `---
name: ${metadata.name}
platform: ${metadata.platform}
version: ${metadata.version}
author: ${metadata.author}
${metadata.mode ? `mode: ${metadata.mode}` : ''}
---

# ${metadata.name}

${metadata.description}
`;
    await writeFile(join(channelPath, 'channel.md'), channelMd);

    // Create config.json if provided
    if (config) {
      await writeFile(join(channelPath, 'config.json'), JSON.stringify(config, null, 2));
    }

    // Create stub handler.js
    const handlerStub = `export async function initialize(config, secrets, sendToAgent) {
  return {
    start: async () => {
      console.log('Channel started');
    },
    stop: async () => {
      console.log('Channel stopped');
    },
    send: async (channelId, text) => {
      console.log(\`Sending to \${channelId}: \${text}\`);
    }
  };
}
`;
    await writeFile(join(channelPath, 'handler.js'), handlerStub);

    // Load the new channel
    const state = await this.loadState();
    const channel = await this.loadChannel(dirName, channelPath, state);

    this.channels.set(dirName, channel);

    log.info({ channel: dirName }, 'Channel created');

    return channel;
  }
}
