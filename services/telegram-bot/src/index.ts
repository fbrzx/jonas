import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createLogger } from '@jonas/shared/utils';
import { TelegramPoller } from './polling.js';

const log = createLogger('telegram-bot');

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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_MODE = process.env.TELEGRAM_MODE ?? 'webhook';
const AGENT_API_URL = process.env.AGENT_API_URL ?? 'http://localhost:3001';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!TELEGRAM_BOT_TOKEN) {
  log.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

// Validate mode
if (!['webhook', 'polling'].includes(TELEGRAM_MODE)) {
  log.error({ mode: TELEGRAM_MODE }, 'Invalid TELEGRAM_MODE (must be "webhook" or "polling")');
  process.exit(1);
}

log.info({ mode: TELEGRAM_MODE }, 'Telegram bot starting');

// Helper: Send message to Telegram
async function sendMessage(chatId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

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

// Helper: Send chat action (typing indicator)
async function sendChatAction(chatId: number, action: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`;

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

// Set webhook on startup
async function setWebhook(webhookUrl: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

  const payload: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ['message'],
  };

  if (WEBHOOK_SECRET) {
    payload.secret_token = WEBHOOK_SECRET;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to set webhook: ${error}`);
  }

  log.info({ webhookUrl }, 'Webhook configured successfully');
}

// Mode-specific startup
if (TELEGRAM_MODE === 'polling') {
  // ============== POLLING MODE ==============
  const pollInterval = Number(process.env.TELEGRAM_POLL_INTERVAL ?? 1000);

  const poller = new TelegramPoller({
    botToken: TELEGRAM_BOT_TOKEN,
    agentApiUrl: AGENT_API_URL,
    pollInterval,
  });

  poller.start().catch((err) => {
    log.error(err, 'Polling failed');
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log.info('Shutting down...');
    poller.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log.info('Shutting down...');
    poller.stop();
    process.exit(0);
  });

} else {
  // ============== WEBHOOK MODE ==============
  const app = new Hono();

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Webhook endpoint - Telegram will POST updates here
  app.post('/webhook', async (c) => {
    try {
      // Verify webhook secret if configured
      if (WEBHOOK_SECRET) {
        const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
        if (secret !== WEBHOOK_SECRET) {
          log.warn('Invalid webhook secret');
          return c.json({ error: 'Unauthorized' }, 401);
        }
      }

      const update: TelegramUpdate = await c.req.json();
      log.info({ updateId: update.update_id }, 'Received update from Telegram');

      // Only handle text messages for now
      if (!update.message?.text) {
        log.debug('Ignoring non-text message');
        return c.json({ ok: true });
      }

      const message = update.message;
      const chatId = message.chat.id;
      const text = message.text;
      const username = message.from.username ?? message.from.first_name;

      log.info({ chatId, username, text }, 'Processing message');

      // Send typing indicator
      await sendChatAction(chatId, 'typing');

      // Call agent API
      const agentResponse = await fetch(`${AGENT_API_URL}/api/chat`, {
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
        await sendMessage(chatId, '❌ Sorry, I encountered an error processing your message.');
        return c.json({ ok: false });
      }

      const { response } = await agentResponse.json() as { response: string };

      // Send response back to Telegram
      await sendMessage(chatId, response);

      log.info({ chatId }, 'Message sent to Telegram');
      return c.json({ ok: true });

    } catch (err) {
      log.error(err, 'Error processing webhook');
      return c.json({ error: 'Internal error' }, 500);
    }
  });

  // Start server
  const port = Number(process.env.TELEGRAM_BOT_PORT ?? 3002);

  serve({ fetch: app.fetch, port }, async () => {
    log.info({ port }, 'Telegram bot webhook server listening');

    // Set webhook if WEBHOOK_URL is provided
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        await setWebhook(webhookUrl);
      } catch (err) {
        log.error(err, 'Failed to set webhook');
        log.warn('Bot will not receive updates until webhook is configured');
      }
    } else {
      log.warn('TELEGRAM_WEBHOOK_URL not set - webhook not configured');
      log.warn('Set TELEGRAM_WEBHOOK_URL=https://your-domain.com/webhook to enable');
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log.info('Shutting down...');
    process.exit(0);
  });
}
