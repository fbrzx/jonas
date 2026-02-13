export interface ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}
