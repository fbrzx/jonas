export type ChannelStatus = 'enabled' | 'disabled';
export type ChannelState = 'stopped' | 'starting' | 'running' | 'error';

export interface ChannelMetadata {
  name: string;
  platform: string;
  version: string;
  author: string;
  description: string;
  mode?: 'webhook' | 'polling' | 'both';
}

export interface ChannelConfig {
  requiredSecrets?: string[];
  optionalSecrets?: string[];
  mode?: 'webhook' | 'polling';
  port?: number;
  pollInterval?: number;
  [key: string]: unknown;
}

export interface PlatformChannel {
  dirName: string;
  metadata: ChannelMetadata;
  status: ChannelStatus;
  state: ChannelState;
  filePath: string;
  loadedAt: string;
  config?: ChannelConfig;
  secretKeys?: string[];
  error?: string;
}

export interface ChannelHandler {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  send: (channelId: string, text: string) => Promise<void>;
}
