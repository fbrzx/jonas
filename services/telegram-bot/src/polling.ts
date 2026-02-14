/**
 * Telegram bot polling mode - actively fetches updates from Telegram API.
 * Use for local development when you don't have a public webhook URL.
 */

import { createLogger } from '@jonas/shared/utils';

const log = createLogger('telegram-polling');

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: 'private' | 'group' | 'supergroup' | 'channel';
      title?: string;
    };
    text?: string;
    date: number;
  };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

interface PollingOptions {
  botToken: string;
  agentApiUrl: string;
  pollInterval?: number;
  onMessage?: (chatId: number, text: string, username: string) => Promise<string>;
}

export class TelegramPoller {
  private botToken: string;
  private agentApiUrl: string;
  private pollInterval: number;
  private offset: number = -1; // -1 means only new messages
  private running: boolean = false;
  private onMessage?: (chatId: number, text: string, username: string) => Promise<string>;

  constructor(options: PollingOptions) {
    this.botToken = options.botToken;
    this.agentApiUrl = options.agentApiUrl;
    this.pollInterval = options.pollInterval ?? 1000;
    this.onMessage = options.onMessage;
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn('Polling already running');
      return;
    }

    this.running = true;
    log.info({ pollInterval: this.pollInterval }, 'Starting Telegram polling mode');

    // Delete webhook if set (can't use both webhook and polling)
    await this.deleteWebhook();

    // Start polling loop
    while (this.running) {
      try {
        await this.poll();
      } catch (err) {
        log.error(err, 'Polling error');
        // Wait before retrying
        await this.sleep(5000);
      }
    }
  }

  stop(): void {
    log.info('Stopping polling');
    this.running = false;
  }

  private async poll(): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates`;

    // Use long polling (30s timeout) to reduce API calls
    const params = new URLSearchParams({
      offset: String(this.offset),
      timeout: '30',
      allowed_updates: JSON.stringify(['message']),
    });

    const response = await fetch(`${url}?${params}`);
    const data: TelegramGetUpdatesResponse = await response.json();

    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }

    const updates = data.result ?? [];

    if (updates.length === 0) {
      // No new messages, loop will continue
      return;
    }

    log.info({ count: updates.length }, 'Received updates from Telegram');

    // Process updates sequentially (important: maintain order)
    for (const update of updates) {
      try {
        await this.handleUpdate(update);
        // Update offset to skip this update next time
        this.offset = update.update_id + 1;
      } catch (err) {
        log.error({ updateId: update.update_id, err }, 'Failed to handle update');
        // Still update offset to avoid getting stuck on bad update
        this.offset = update.update_id + 1;
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    // Only handle text messages for now
    if (!update.message?.text) {
      log.debug({ updateId: update.update_id }, 'Ignoring non-text message');
      return;
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text;
    const username = message.from.username ?? message.from.first_name;

    log.info({ chatId, username, text }, 'Processing message');

    // Send typing indicator
    await this.sendChatAction(chatId, 'typing');

    let response: string;

    if (this.onMessage) {
      // Use custom message handler if provided
      response = await this.onMessage(chatId, text, username);
    } else {
      // Default: call agent API
      response = await this.queryAgent(chatId, text);
    }

    // Send response back to Telegram
    await this.sendMessage(chatId, response);

    log.info({ chatId }, 'Response sent to Telegram');
  }

  private async queryAgent(chatId: number, text: string): Promise<string> {
    try {
      const agentResponse = await fetch(`${this.agentApiUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          channelType: 'telegram',
          channelId: String(chatId),
          sessionKey: `telegram:${chatId}`,
        }),
      });

      if (!agentResponse.ok) {
        log.error({ status: agentResponse.status }, 'Agent API error');
        return '❌ Sorry, I encountered an error processing your message.';
      }

      const { response } = await agentResponse.json() as { response: string };
      return response;

    } catch (err) {
      log.error(err, 'Failed to query agent');
      return '❌ Failed to process your message. Please try again.';
    }
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error({ error }, 'Failed to send message to Telegram');
      throw new Error(`Telegram API error: ${error}`);
    }
  }

  private async sendChatAction(chatId: number, action: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendChatAction`;

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        action,
      }),
    }).catch(() => {
      // Ignore errors for chat actions
    });
  }

  private async deleteWebhook(): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/deleteWebhook`;

    try {
      const response = await fetch(url, { method: 'POST' });
      const data = await response.json() as { ok: boolean; description?: string };

      if (!data.ok) {
        log.warn({ description: data.description }, 'Failed to delete webhook');
      } else {
        log.info('Webhook deleted (polling mode)');
      }
    } catch (err) {
      log.warn(err, 'Failed to delete webhook');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
