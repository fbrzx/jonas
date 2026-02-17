/**
 * Python Channel Process Manager
 *
 * Spawns and manages Python channel handler processes.
 * Communicates via stdio using JSON-RPC protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '@jonas/shared/utils';
import type { ChannelHandler } from '@jonas/shared/types';

const log = createLogger('python-channel');

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

export interface PythonChannelOptions {
  handlerPath: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  onMessageReceived: (channelId: string, message: string) => Promise<void>;
  channelName: string;
}

export class PythonChannelProcess implements ChannelHandler {
  private process: ChildProcess | null = null;
  private readonly options: PythonChannelOptions;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private buffer = '';

  constructor(options: PythonChannelOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Process already started');
    }

    log.info({ channel: this.options.channelName }, 'Starting Python channel process');

    // Spawn Python handler
    this.process = spawn('python3', [this.options.handlerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Setup stdout handler
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data);
    });

    // Setup stderr handler (logging)
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        log.debug({ channel: this.options.channelName, stderr: msg }, 'Python stderr');
      }
    });

    // Setup process exit handler
    this.process.on('exit', (code, signal) => {
      log.info(
        { channel: this.options.channelName, code, signal },
        'Python channel process exited'
      );
      this.cleanup();
    });

    this.process.on('error', (err) => {
      log.error({ channel: this.options.channelName, err }, 'Python channel process error');
      this.cleanup();
    });

    // Initialize the handler
    await this.sendRequest('initialize', {
      config: this.options.config,
      secrets: this.options.secrets,
    });

    // Start the handler
    await this.sendRequest('start', {});

    log.info({ channel: this.options.channelName }, 'Python channel started');
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    log.info({ channel: this.options.channelName }, 'Stopping Python channel process');

    try {
      // Send stop request
      await this.sendRequest('stop', {});
    } catch (err) {
      log.warn({ channel: this.options.channelName, err }, 'Error sending stop request');
    }

    this.cleanup();
  }

  async send(channelId: string, text: string): Promise<void> {
    if (!this.process) {
      throw new Error('Process not started');
    }

    await this.sendRequest('send', {
      channel_id: channelId,
      text,
    });
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        reject(new Error('Process not available'));
        return;
      }

      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      const line = JSON.stringify(request) + '\n';
      this.process.stdin.write(line);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private handleStdout(data: Buffer): void {
    // Append to buffer
    this.buffer += data.toString();

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const message: JsonRpcMessage = JSON.parse(line);
        this.handleMessage(message);
      } catch (err) {
        log.error(
          { channel: this.options.channelName, line, err },
          'Failed to parse JSON-RPC message'
        );
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    // Check if it's a response
    if ('id' in message) {
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);

      if (!pending) {
        log.warn(
          { channel: this.options.channelName, id: response.id },
          'Received response for unknown request'
        );
        return;
      }

      this.pendingRequests.delete(response.id);

      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    // It's a notification
    const notification = message as JsonRpcNotification;

    if (notification.method === 'message_received') {
      const { channel_id, message: msg } = notification.params as {
        channel_id: string;
        message: string;
      };

      this.options
        .onMessageReceived(channel_id, msg)
        .catch((err) => {
          log.error(
            { channel: this.options.channelName, err },
            'Error handling message_received notification'
          );
        });
    } else {
      log.warn(
        { channel: this.options.channelName, method: notification.method },
        'Unknown notification method'
      );
    }
  }

  private cleanup(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    // Reject all pending requests
    for (const [id, { reject }] of this.pendingRequests) {
      reject(new Error('Process terminated'));
    }
    this.pendingRequests.clear();
  }
}
