import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from 'matrix-bot-sdk';
import { createLogger } from '@jonas/shared/utils';
import type { Channel } from '@jonas/shared/types';
import type { AgentCore } from '../agent/core.js';
import type { ChannelAdapter } from './types.js';

const log = createLogger('matrix');

export class MatrixChannel implements ChannelAdapter {
  private client: MatrixClient | null = null;
  private running = false;

  constructor(private agent: AgentCore) {}

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    const homeserver = process.env.MATRIX_HOMESERVER;
    const userId = process.env.MATRIX_BOT_USER;
    const password = process.env.MATRIX_BOT_PASSWORD;

    if (!homeserver || !userId || !password) {
      throw new Error('Matrix configuration incomplete');
    }

    // Login to get access token
    const loginResponse = await fetch(`${homeserver}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: userId.split(':')[0].slice(1) },
        password,
      }),
    });

    if (!loginResponse.ok) {
      throw new Error(`Matrix login failed: ${loginResponse.status}`);
    }

    const { access_token } = (await loginResponse.json()) as { access_token: string };

    const storage = new SimpleFsStorageProvider('/data/matrix-bot-storage.json');
    this.client = new MatrixClient(homeserver, access_token, storage);

    AutojoinRoomsMixin.setupOnClient(this.client);

    this.client.on('room.message', async (roomId: string, event: Record<string, unknown>) => {
      if (!event.content || (event as { sender?: string }).sender === userId) return;

      const content = event.content as { msgtype?: string; body?: string };
      if (content.msgtype !== 'm.text' || !content.body) return;

      const userMessage = content.body;
      const channel: Channel = { type: 'matrix', id: roomId };

      try {
        log.info({ roomId, message: userMessage.slice(0, 100) }, 'Received Matrix message');

        const response = await this.agent.chat(userMessage, channel);

        await this.client!.sendMessage(roomId, {
          msgtype: 'm.text',
          body: response,
          format: 'org.matrix.custom.html',
          formatted_body: response,
        });
      } catch (err) {
        log.error(err, 'Failed to handle Matrix message');
        await this.client!.sendMessage(roomId, {
          msgtype: 'm.text',
          body: 'Sorry, I encountered an error processing your message.',
        });
      }
    });

    await this.client.start();
    this.running = true;
    log.info('Matrix bot connected');
  }

  async sendToRoom(roomId: string, message: string): Promise<void> {
    if (!this.client) {
      throw new Error('Matrix client not connected');
    }
    await this.client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: message,
      format: 'org.matrix.custom.html',
      formatted_body: message,
    });
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.stop();
      this.running = false;
      log.info('Matrix bot disconnected');
    }
  }
}
