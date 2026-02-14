# Telegram Bot Setup Guide

This guide explains how to set up the Telegram bot for Jonas.

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Choose a name (e.g., "Jonas Assistant")
4. Choose a username (e.g., "jonas_assistant_bot")
5. Copy the bot token (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Configure Environment Variables

Add to your `.env`:

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz

# For production (webhook)
TELEGRAM_WEBHOOK_URL=https://your-domain.com/webhook
TELEGRAM_WEBHOOK_SECRET=your-random-secret-here

# For local development (leave webhook URL empty to skip auto-config)
# TELEGRAM_WEBHOOK_URL=
```

### 3. Start the Bot

```bash
# Build and start all services including telegram-bot
docker compose up -d

# Check logs
docker compose logs -f telegram-bot
```

### 4. Set Webhook (Production)

The bot automatically sets the webhook on startup if `TELEGRAM_WEBHOOK_URL` is configured.

You need to expose the webhook endpoint publicly:

**Option A: Using nginx (recommended)**
```nginx
location /webhook {
    proxy_pass http://localhost:3002/webhook;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

**Option B: Direct port exposure (not recommended)**
```yaml
# In docker-compose.yml
ports:
  - "443:3002"  # Expose directly (requires SSL)
```

### 5. Test the Bot

1. Open Telegram
2. Search for your bot username
3. Send `/start` or any message
4. Bot should respond using Jonas agent!

## Architecture

```
Telegram → Webhook → telegram-bot service → Agent API → Response → Telegram
```

The telegram-bot service:
1. Receives webhook POSTs from Telegram
2. Forwards messages to agent API at `/api/chat`
3. Sends agent responses back to Telegram user
4. Each chat gets its own session: `telegram:{chatId}`

## Local Development vs Production

### Local Development (no public URL)

If you don't have a public domain for webhooks, you can use:

**Option 1: ngrok (easiest)**
```bash
# Install ngrok and expose port 3002
ngrok http 3002

# Copy the https URL (e.g., https://abc123.ngrok.io)
# Set in .env:
TELEGRAM_WEBHOOK_URL=https://abc123.ngrok.io/webhook

# Restart telegram-bot
docker compose restart telegram-bot
```

**Option 2: Polling (alternative implementation)**
If you need polling instead of webhooks, let me know and I can add that mode.

### Production (with domain)

```bash
# In .env
TELEGRAM_WEBHOOK_URL=https://your-domain.com/webhook
TELEGRAM_WEBHOOK_SECRET=use-a-strong-random-secret-here

# The bot will auto-configure the webhook on startup
```

## Webhook Security

The webhook endpoint is secured with:

1. **Secret token** - Telegram includes `X-Telegram-Bot-Api-Secret-Token` header
2. **IP whitelist** (optional) - You can add nginx rules to only allow Telegram IPs

Example nginx security:
```nginx
location /webhook {
    # Only allow Telegram servers
    allow 149.154.160.0/20;
    allow 91.108.4.0/22;
    deny all;

    proxy_pass http://localhost:3002/webhook;
}
```

## Managing Multiple Bots

You can run separate bots for dev/prod:

**Development bot:**
```bash
TELEGRAM_BOT_TOKEN=dev_bot_token_here
TELEGRAM_WEBHOOK_URL=https://dev.your-domain.com/webhook
```

**Production bot:**
```bash
TELEGRAM_BOT_TOKEN=prod_bot_token_here
TELEGRAM_WEBHOOK_URL=https://your-domain.com/webhook
```

Just use different tokens and webhook URLs for each environment.

## Troubleshooting

### Bot not responding

1. **Check bot is running:**
   ```bash
   docker compose ps telegram-bot
   docker compose logs telegram-bot
   ```

2. **Verify webhook is set:**
   ```bash
   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
   ```
   Should show your webhook URL.

3. **Test webhook endpoint:**
   ```bash
   curl https://your-domain.com/webhook
   # Should return 401 (webhook secret required) or process a request
   ```

4. **Check agent is reachable:**
   ```bash
   docker compose exec telegram-bot wget -qO- http://agent:3001/api/status
   ```

### Webhook not being called

- Ensure your domain has valid SSL (Telegram requires HTTPS)
- Check nginx logs for incoming requests
- Verify webhook URL is publicly accessible
- Check firewall rules

### "Unauthorized" errors

- Double-check `TELEGRAM_BOT_TOKEN` is correct
- Ensure no extra spaces or quotes in token
- Verify you're using the right bot

## Advanced Configuration

### Custom Commands

You can add command handling in `services/telegram-bot/src/index.ts`:

```typescript
// Handle /start command
if (text === '/start') {
  await sendMessage(chatId, 'Hello! I\'m Jonas, your AI assistant.');
  return c.json({ ok: true });
}
```

### Group Chat Support

The bot works in private chats by default. For group chats:

1. Disable privacy mode in @BotFather:
   - Send `/setprivacy`
   - Select your bot
   - Select "Disable"

2. Add the bot to your group
3. Messages mentioning the bot will be processed

### Rate Limiting

Add rate limiting to prevent abuse:

```typescript
// TODO: Implement rate limiting per chat_id
```

## Features

- ✅ Webhook-based (efficient, production-ready)
- ✅ Typing indicators while processing
- ✅ Markdown formatting support
- ✅ Session management (persistent conversations)
- ✅ Webhook secret verification
- ✅ Health check endpoint
- ✅ Graceful error handling

## Roadmap

Future enhancements:
- [ ] Polling mode for local development
- [ ] Rich message types (photos, documents)
- [ ] Inline keyboards for interactions
- [ ] Command menu
- [ ] Group chat optimizations
- [ ] Rate limiting
- [ ] Analytics/usage tracking
